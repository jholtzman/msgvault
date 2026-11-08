package gmessagesweb

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strings"

	"go.kenn.io/msgvault/internal/export"
	"go.kenn.io/msgvault/internal/mime"
	"go.kenn.io/msgvault/internal/store"
)

type Importer struct {
	store *store.Store
	opts  ImportOptions
}

func NewImporter(st *store.Store, opts ImportOptions) *Importer {
	return &Importer{store: st, opts: opts}
}

// ImportDir imports every capture file in dir as one sync run of the owner's
// source.
//
// A file and the images and videos it lists are deleted once all of its
// messages are stored. A file that fails to parse or store stays where it is
// with its attachments, so the next run retries it, and the run goes on to the remaining
// files. The run then fails, naming each failed file.
func (i *Importer) ImportDir(ctx context.Context, dir string) (ImportSummary, error) {
	if !e164.MatchString(strings.TrimSpace(i.opts.OwnerPhone)) {
		return ImportSummary{}, errors.New("owner phone in E.164 format is required for google-messages-web imports")
	}
	i.opts.OwnerPhone = strings.TrimSpace(i.opts.OwnerPhone)
	files, err := DiscoverFiles(dir)
	if err != nil {
		return ImportSummary{}, fmt.Errorf("read capture folder: %w", err)
	}
	src, err := i.store.GetOrCreateSource(SourceType, i.opts.OwnerPhone)
	if err != nil {
		return ImportSummary{}, fmt.Errorf("get source: %w", err)
	}
	syncID, err := i.store.StartSync(src.ID, AdapterName)
	if err != nil {
		return ImportSummary{}, fmt.Errorf("start sync: %w", err)
	}
	scoped := *i
	scoped.store = i.store.ScopedToSync(src.ID, syncID)
	summary, importErr := scoped.ImportFilesIntoSource(ctx, src.ID, files)
	// Messages written before a failure or cancel stay committed, so their
	// conversations need current statistics either way.
	refreshCtx := context.WithoutCancel(ctx)
	if len(summary.MessageIDs) > 0 {
		if err := scoped.store.RecomputeConversationStatsContext(refreshCtx, src.ID); err != nil {
			importErr = errors.Join(importErr, fmt.Errorf("recompute conversation stats: %w", err))
		}
	}
	if importErr != nil {
		_ = scoped.store.FailSync(syncID, importErr.Error())
		return summary, importErr
	}
	if err := scoped.store.UpdateSyncCheckpoint(syncID, &store.Checkpoint{
		MessagesProcessed: int64(summary.MessagesImported),
		MessagesAdded:     int64(summary.MessagesImported),
	}); err != nil {
		_ = scoped.store.FailSync(syncID, err.Error())
		return summary, fmt.Errorf("update sync checkpoint: %w", err)
	}
	if err := scoped.store.CompleteSync(syncID, ""); err != nil {
		return summary, fmt.Errorf("complete sync: %w", err)
	}
	return summary, nil
}

// ImportFilesIntoSource imports capture files into an existing source
// without owning the sync run. It stops early only when ctx is cancelled.
func (i *Importer) ImportFilesIntoSource(ctx context.Context, sourceID int64, files []string) (ImportSummary, error) {
	summary := ImportSummary{FilesSeen: len(files)}
	var errs []error
	for _, path := range files {
		if err := ctx.Err(); err != nil {
			errs = append(errs, err)
			break
		}
		if err := i.importFile(ctx, sourceID, path, &summary); err != nil {
			summary.FilesFailed++
			errs = append(errs, fmt.Errorf("capture file %s: %w", filepath.Base(path), err))
			continue
		}
		summary.FilesImported++
	}
	return summary, errors.Join(errs...)
}

func (i *Importer) importFile(ctx context.Context, sourceID int64, path string, summary *ImportSummary) error {
	messages, err := ParseFile(path, i.opts.OwnerPhone)
	if err != nil {
		return err
	}
	var files []string
	for _, msg := range messages {
		for _, a := range msg.Attachments {
			files = append(files, a.File)
		}
	}
	if len(files) > 0 && strings.TrimSpace(i.opts.AttachmentsDir) == "" {
		return errors.New("file lists images or videos, and no attachments folder is configured")
	}
	// Every attachment is checked before any message is stored, as every
	// line is parsed first.
	dir := filepath.Dir(path)
	if err := LoadAttachments(dir, messages); err != nil {
		return err
	}
	for n, msg := range messages {
		id, err := i.importMessage(ctx, sourceID, msg)
		if id != 0 {
			summary.MessageIDs = append(summary.MessageIDs, id)
		}
		if err != nil {
			return &LineError{Line: n + 1, Err: err}
		}
		summary.MessagesImported++
		for _, a := range msg.Attachments {
			if isVideo(a.MIMEType) {
				summary.VideosImported++
			} else {
				summary.ImagesImported++
			}
		}
	}
	// The capture file goes first: an attachment left behind by a failure
	// below is never read again, while a capture file whose attachments
	// were gone would fail on every later run.
	if err := os.Remove(path); err != nil {
		return fmt.Errorf("remove imported file: %w", err)
	}
	for _, name := range files {
		if err := os.Remove(filepath.Join(dir, name)); err != nil && !errors.Is(err, os.ErrNotExist) {
			slog.Warn("failed to remove imported Google Messages for web attachment",
				"file", name,
				"error", err)
		}
	}
	return nil
}

func (i *Importer) importMessage(ctx context.Context, sourceID int64, msg Message) (int64, error) {
	participantIDs := make([]int64, len(msg.Participants))
	senderID, ownerID := int64(0), int64(0)
	for n, phone := range msg.Participants {
		name := ""
		if phone == i.opts.OwnerPhone {
			name = "Me"
		}
		id, err := i.store.EnsureParticipantByPhone(ctx, phone, name, ParticipantIdentifierType)
		if err != nil {
			return 0, fmt.Errorf("participant %d: %w", n, err)
		}
		participantIDs[n] = id
		if phone == msg.Sender {
			senderID = id
		}
		if phone == i.opts.OwnerPhone {
			ownerID = id
		}
	}
	conversationType := "direct_chat"
	if len(msg.Participants) > 2 {
		conversationType = "group_chat"
	}
	convID, err := i.store.EnsureConversationWithTypeContext(ctx, sourceID, msg.ConversationID, conversationType, "")
	if err != nil {
		return 0, fmt.Errorf("ensure conversation: %w", err)
	}
	var recipientIDs []int64
	for _, id := range participantIDs {
		if err := i.store.EnsureConversationParticipantContext(ctx, convID, id, "member"); err != nil {
			return 0, fmt.Errorf("ensure conversation participant: %w", err)
		}
		if id != senderID {
			recipientIDs = append(recipientIDs, id)
		}
	}
	fromMe := senderID == ownerID
	text := msg.Text
	msgID, err := i.store.UpsertMessageContext(ctx, &store.Message{
		ConversationID:  convID,
		SourceID:        sourceID,
		SourceMessageID: msg.MessageID,
		MessageType:     MessageType,
		SentAt:          sql.NullTime{Time: msg.SentAtTime, Valid: true},
		SenderID:        sql.NullInt64{Int64: senderID, Valid: true},
		IsFromMe:        fromMe,
		// The page shows sent messages and received ones alike; the capture
		// file does not mark a message that failed to send.
		IsSent:          sql.NullBool{Bool: true, Valid: true},
		Snippet:         sql.NullString{String: text, Valid: text != ""},
		SizeEstimate:    int64(len(text)) + attachmentBytes(msg),
		HasAttachments:  len(msg.Attachments) > 0,
		AttachmentCount: len(msg.Attachments),
	})
	if err != nil {
		return 0, fmt.Errorf("upsert message: %w", err)
	}
	// The message row has committed, so later failures still return its ID:
	// the caller must refresh conversation statistics for it.
	if text != "" {
		if err := i.store.UpsertMessageBodyContext(ctx, msgID, sql.NullString{String: text, Valid: true}, sql.NullString{}); err != nil {
			return msgID, fmt.Errorf("upsert body: %w", err)
		}
	}
	if err := i.storeAttachments(ctx, msgID, msg); err != nil {
		return msgID, err
	}
	if err := i.store.UpsertMessageRawWithFormatContext(ctx, msgID, msg.Raw, RawFormat); err != nil {
		return msgID, fmt.Errorf("upsert raw record: %w", err)
	}
	if err := i.store.ReplaceMessageRecipientsContext(ctx, msgID, "from", []int64{senderID}, []string{""}); err != nil {
		return msgID, fmt.Errorf("replace from recipient: %w", err)
	}
	if err := i.store.ReplaceMessageRecipientsContext(ctx, msgID, "to", recipientIDs, make([]string, len(recipientIDs))); err != nil {
		return msgID, fmt.Errorf("replace to recipients: %w", err)
	}
	// The message is saved; index it even when a stop request arrives now,
	// or it stays out of search until a reimport.
	if err := i.store.UpsertFTSContext(context.WithoutCancel(ctx), msgID, "", text, "", "", ""); err != nil {
		slog.Warn("failed to update Google Messages for web FTS index",
			"message_id", msgID,
			"error", err)
	}
	return msgID, nil
}

// storeAttachments puts each image and video in the attachment store and
// records it on the message. The capture file is deleted after the import,
// so each file is written durably before its record.
func (i *Importer) storeAttachments(ctx context.Context, msgID int64, msg Message) error {
	for n, a := range msg.Attachments {
		if isVideo(a.MIMEType) {
			if err := i.storeVideo(ctx, msgID, msg, n); err != nil {
				return err
			}
			continue
		}
		filename := fmt.Sprintf("image-%d.%s", n+1, imageExtensions[a.MIMEType])
		receipt, err := export.StoreAttachmentFileDurable(ctx, i.opts.AttachmentsDir, &mime.Attachment{
			Filename:    filename,
			ContentType: a.MIMEType,
			Size:        len(msg.Content[n]),
			ContentHash: a.SHA256,
			Content:     msg.Content[n],
		})
		if err != nil {
			return fmt.Errorf("attachment %d: store image: %w", n, err)
		}
		if err := i.store.UpsertAttachmentRecord(ctx, msgID, store.AttachmentWrite{
			Filename:      filename,
			MIMEType:      a.MIMEType,
			StoragePath:   receipt.StoragePath,
			ContentHash:   receipt.ContentHash,
			Size:          a.Size,
			MediaType:     "image",
			Role:          store.AttachmentRoleStandalone,
			RoleSource:    store.AttachmentRoleSourceImporterSemantics,
			SourcePartKey: fmt.Sprintf("google-messages-web:image:%d", n),
		}); err != nil {
			return fmt.Errorf("attachment %d: upsert attachment: %w", n, err)
		}
	}
	return nil
}

// storeVideo streams one video from the capture folder into the attachment
// store, so a large video is never held in memory.
func (i *Importer) storeVideo(ctx context.Context, msgID int64, msg Message, n int) error {
	a := msg.Attachments[n]
	filename := fmt.Sprintf("video-%d.%s", n+1, videoExtensions[a.MIMEType])
	storagePath, contentHash, _, err := export.StoreAttachmentFromPathDurable(ctx, i.opts.AttachmentsDir, msg.Paths[n], a.SHA256, a.Size, 0)
	if err != nil {
		return fmt.Errorf("attachment %d: store video: %w", n, err)
	}
	if err := i.store.UpsertAttachmentRecord(ctx, msgID, store.AttachmentWrite{
		Filename:      filename,
		MIMEType:      a.MIMEType,
		StoragePath:   storagePath,
		ContentHash:   contentHash,
		Size:          a.Size,
		MediaType:     "video",
		Role:          store.AttachmentRoleStandalone,
		RoleSource:    store.AttachmentRoleSourceImporterSemantics,
		SourcePartKey: fmt.Sprintf("google-messages-web:video:%d", n),
	}); err != nil {
		return fmt.Errorf("attachment %d: upsert attachment: %w", n, err)
	}
	return nil
}

func attachmentBytes(msg Message) int64 {
	var n int64
	for _, a := range msg.Attachments {
		n += a.Size
	}
	return n
}
