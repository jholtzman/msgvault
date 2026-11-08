package cmd

import (
	"context"
	"errors"
	"fmt"
	"io"

	"github.com/spf13/cobra"
	"go.kenn.io/msgvault/internal/api"
	"go.kenn.io/msgvault/internal/config"
	"go.kenn.io/msgvault/internal/gmessagesweb"
	"go.kenn.io/msgvault/internal/store"
)

func newImportGoogleMessagesWebCmd() *cobra.Command {
	var opts gmessagesweb.ImportOptions
	var contactsPath string
	cmd := &cobra.Command{
		Use:   "import-google-messages-web <folder>",
		Short: "Import conversations captured from Google Messages for web",
		Long: `Import every capture file in a folder of conversations captured from
Google Messages for web, with the images and videos each file lists. Each
file and its attachments are deleted once all of its messages are stored. A file that fails to
import stays in the folder and is named in the error, and the remaining files
are still imported.

Capture files carry phone numbers only. --contacts names the people behind
them from a vCard file, such as a Google Contacts export: each participant
with one of a contact's numbers and no name yet gets the contact's name. The
file is read after the import, so running the command on an empty folder
names participants already in the archive.`,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			state := invocationFromCommand(cmd)
			if state == nil || state.cfg == nil {
				return errors.New("configuration is unavailable")
			}
			if opts.OwnerPhone == "" {
				return errors.New("--owner-phone is required")
			}
			if !isDaemonCLISubprocess() {
				if contactsPath != "" {
					// The --contacts file is caller-local; a configured
					// remote daemon cannot read it.
					return runDaemonCLICommandHTTPFromCobraWithLocalFiles(cmd, args, nil)
				}
				return runDaemonCLICommandHTTPFromCobra(cmd, args)
			}
			st, cleanup, err := openWritableStoreAndInitForIngestInvocation(cmd.Context(), state)
			if err != nil {
				return err
			}
			defer cleanup()
			summary, err := importGoogleMessagesWeb(cmd.Context(), st, args[0], opts.OwnerPhone, opts.OwnerPhone)
			cmd.Printf("Imported %d messages, %d images and %d videos from %d of %d files\n",
				summary.MessagesImported, summary.ImagesImported, summary.VideosImported, summary.FilesImported, summary.FilesSeen)
			if contactsPath == "" {
				return err
			}
			// Messages from the files that did import are committed, so their
			// participants are named even when another file failed.
			return errors.Join(err, applyGoogleMessagesWebContacts(cmd, st, contactsPath))
		},
	}
	cmd.Flags().StringVar(&opts.OwnerPhone, "owner-phone", "", "Owner phone number in E.164 format")
	cmd.Flags().StringVar(&contactsPath, "contacts", "", "vCard file used to fill empty participant names")
	return cmd
}

// importGoogleMessagesWeb runs one import of dir and, once anything is
// stored, records the owner's number as their identity for the source.
func importGoogleMessagesWeb(ctx context.Context, st *store.Store, dir, ownerPhone, name string) (gmessagesweb.ImportSummary, error) {
	state := invocationFromContext(ctx)
	opts := gmessagesweb.ImportOptions{OwnerPhone: ownerPhone}
	if state != nil && state.cfg != nil {
		opts.AttachmentsDir = state.cfg.AttachmentsDir()
	}
	summary, err := gmessagesweb.NewImporter(st, opts).ImportDir(ctx, dir)
	if summary.MessagesImported == 0 {
		return summary, err
	}
	// The messages committed; record the owner and finish the migration even
	// when a stop request arrives now.
	post := context.WithoutCancel(ctx)
	source, sourceErr := st.GetSourceByTypeAndIdentifier(post, gmessagesweb.SourceType, ownerPhone)
	if sourceErr != nil {
		return summary, errors.Join(err, fmt.Errorf("get source: %w", sourceErr))
	}
	confirmDefaultIdentity(post, io.Discard, st, source.ID, name, ownerPhone, "phone-e164", state.logger)
	if migrateErr := runPostSourceCreateMigrationsForInvocation(post, st, state); migrateErr != nil {
		return summary, errors.Join(err, fmt.Errorf("post-source-create migrations: %w", migrateErr))
	}
	return summary, err
}

// applyGoogleMessagesWebContacts names participants from a vCard file and
// refreshes the analytics cache when any name changed.
func applyGoogleMessagesWebContacts(cmd *cobra.Command, st *store.Store, path string) error {
	// The import before this committed; name its participants even when a
	// stop request arrives now.
	ctx := context.WithoutCancel(cmd.Context())
	contacts, err := gmessagesweb.ApplyContacts(ctx, st, path)
	cmd.Printf("Named participants from %d of %d contacts\n", contacts.Named, contacts.Contacts)
	if err != nil {
		return err
	}
	if contacts.Named == 0 {
		return nil
	}
	state := invocationFromCommand(cmd)
	if state == nil || state.cfg == nil {
		return errors.New("configuration is unavailable")
	}
	return rebuildCacheAfterWrite(ctx, state.cfg.DatabaseDSN(), state)
}

func runScheduledGoogleMessagesWebSource(ctx context.Context, st *store.Store, src config.GoogleMessagesWebSource) (retErr error) {
	jobName, _ := api.SchedulerJobNameForSource(gmessagesweb.SourceType, src.OwnerPhone)
	defer func() {
		retErr = errors.Join(retErr, rebuildCacheAfterScheduledSync(context.WithoutCancel(ctx), jobName))
	}()
	source, err := st.GetSourceByTypeAndIdentifier(ctx, gmessagesweb.SourceType, src.OwnerPhone)
	if err != nil && !errors.Is(err, store.ErrSourceNotFound) {
		return recordSyncAttempt(ctx, gmessagesweb.SourceType, src.OwnerPhone, err)
	}
	if source != nil && source.MergedIntoSourceID != 0 {
		return nil
	}
	summary, err := importGoogleMessagesWeb(ctx, st, src.Path, src.OwnerPhone, src.Name)
	var contacts gmessagesweb.ContactsSummary
	if src.Contacts != "" {
		// Every run reads the file, so participants from this run's messages
		// are named as soon as they arrive, and an updated export names the
		// ones stored earlier. Messages from files that imported are
		// committed, so this runs even when another file failed.
		var contactsErr error
		contacts, contactsErr = gmessagesweb.ApplyContacts(context.WithoutCancel(ctx), st, src.Contacts)
		err = errors.Join(err, contactsErr)
	}
	if err != nil {
		err = fmt.Errorf("google-messages-web source %q: %w", src.Name, err)
	}
	if state := invocationFromContext(ctx); state != nil && state.logger != nil {
		state.logger.Info("google-messages-web import finished", "source", src.Name,
			"files", summary.FilesImported, "failed_files", summary.FilesFailed, "messages", summary.MessagesImported,
			"images", summary.ImagesImported,
			"videos", summary.VideosImported,
			"contacts_named", contacts.Named)
	}
	return recordSyncAttempt(ctx, gmessagesweb.SourceType, src.OwnerPhone, err)
}

func init() {
	rootCmd.AddCommand(newImportGoogleMessagesWebCmd())
}
