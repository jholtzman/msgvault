package gmessagesweb

import (
	"bufio"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json/v2"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
)

const (
	// MaxLineBytes bounds one line. Text is at most MaxTextBytes, and JSON
	// escaping can grow it up to six times.
	MaxLineBytes = 8 << 20
	// MaxTextBytes bounds one message's text.
	MaxTextBytes = 1 << 20
	// MaxParticipants bounds a group conversation.
	MaxParticipants = 1000
	// MaxPageMessageIDBytes bounds the page's own message ID.
	MaxPageMessageIDBytes = 256
	// MaxAttachments bounds the images in one message.
	MaxAttachments = 20
	// MaxAttachmentBytes bounds one image, as the SMS Backup & Restore
	// importer bounds an MMS part.
	MaxAttachmentBytes = 25 << 20
)

var (
	hexSHA256 = regexp.MustCompile(`^[0-9a-f]{64}$`)
	e164      = regexp.MustCompile(`^\+[1-9][0-9]{6,14}$`)
	// An attachment file sits directly in the capture folder, is not hidden
	// and is not itself a capture file.
	attachmentFile = regexp.MustCompile(`^[0-9A-Za-z][0-9A-Za-z._-]{0,199}$`)
)

// LineError names the line of a capture file that failed.
type LineError struct {
	Line int
	Err  error
}

func (e *LineError) Error() string { return fmt.Sprintf("line %d: %v", e.Line, e.Err) }

func (e *LineError) Unwrap() error { return e.Err }

// ParseFile reads and validates a whole capture file. It returns no
// messages unless every line is valid.
func ParseFile(path string, ownerPhone string) ([]Message, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer func() { _ = f.Close() }()
	return Parse(f, ownerPhone)
}

// Parse reads and validates capture lines from r. Blank lines are not
// allowed: a capture tool never writes one, so one means damage.
func Parse(r io.Reader, ownerPhone string) ([]Message, error) {
	scanner := bufio.NewScanner(r)
	scanner.Buffer(make([]byte, 0, 64<<10), MaxLineBytes)
	var out []Message
	lineNo := 0
	for scanner.Scan() {
		lineNo++
		raw := slices.Clone(scanner.Bytes())
		msg, err := parseLine(raw, ownerPhone)
		if err != nil {
			return nil, &LineError{Line: lineNo, Err: err}
		}
		out = append(out, msg)
	}
	if err := scanner.Err(); err != nil {
		if errors.Is(err, bufio.ErrTooLong) {
			return nil, &LineError{Line: lineNo + 1, Err: fmt.Errorf("line is longer than %d bytes", MaxLineBytes)}
		}
		return nil, err
	}
	if len(out) == 0 {
		return nil, errors.New("file has no messages")
	}
	return out, nil
}

func parseLine(raw []byte, ownerPhone string) (Message, error) {
	var line Line
	// Unmarshal also refuses trailing data, duplicate names, and invalid
	// UTF-8.
	if err := json.Unmarshal(raw, &line, json.RejectUnknownMembers(true)); err != nil {
		return Message{}, fmt.Errorf("not a capture record: %w", err)
	}
	sentAt, err := line.validate(ownerPhone)
	if err != nil {
		return Message{}, err
	}
	return Message{Line: line, SentAtTime: sentAt, Raw: raw}, nil
}

// validate reports the first problem with the line. Errors name fields,
// never their values, because values are message content and numbers.
func (l *Line) validate(ownerPhone string) (time.Time, error) {
	switch {
	case !hexSHA256.MatchString(l.MessageID):
		return time.Time{}, errors.New("message_id is not a lowercase hex SHA-256")
	case !hexSHA256.MatchString(l.ConversationID):
		return time.Time{}, errors.New("conversation_id is not a lowercase hex SHA-256")
	case len(l.Participants) < 2 || len(l.Participants) > MaxParticipants:
		return time.Time{}, fmt.Errorf("participants has %d entries", len(l.Participants))
	case !e164.MatchString(l.Sender):
		return time.Time{}, errors.New("sender is not an E.164 number")
	case l.SentAtPrecision != SentAtPrecisionMinute:
		return time.Time{}, fmt.Errorf("sent_at_precision is not %q", SentAtPrecisionMinute)
	case len(l.Text) > MaxTextBytes:
		return time.Time{}, fmt.Errorf("text is longer than %d bytes", MaxTextBytes)
	case !utf8.ValidString(l.Text):
		return time.Time{}, errors.New("text is not valid UTF-8")
	case l.Attachments == nil:
		return time.Time{}, errors.New("attachments is missing")
	case len(l.Attachments) > MaxAttachments:
		return time.Time{}, fmt.Errorf("attachments has more than %d entries", MaxAttachments)
	case len(l.PageMessageID) > MaxPageMessageIDBytes:
		return time.Time{}, fmt.Errorf("page_message_id is longer than %d bytes", MaxPageMessageIDBytes)
	case !printable(l.PageMessageID):
		return time.Time{}, errors.New("page_message_id is not printable text")
	}
	for n, a := range l.Attachments {
		if err := a.validate(); err != nil {
			return time.Time{}, fmt.Errorf("attachment %d: %w", n, err)
		}
	}
	hasSender, hasOwner := false, false
	for i, p := range l.Participants {
		if !e164.MatchString(p) {
			return time.Time{}, fmt.Errorf("participant %d is not an E.164 number", i)
		}
		if i > 0 && p <= l.Participants[i-1] {
			return time.Time{}, errors.New("participants are not sorted and distinct")
		}
		hasSender = hasSender || p == l.Sender
		hasOwner = hasOwner || p == ownerPhone
	}
	if !hasSender {
		return time.Time{}, errors.New("sender is not a participant")
	}
	if !hasOwner {
		return time.Time{}, errors.New("owner phone is not a participant")
	}
	sentAt, err := time.Parse(time.RFC3339, l.SentAt)
	if err != nil || sentAt.Location() != time.UTC || sentAt.Format("2006-01-02T15:04:00Z") != l.SentAt {
		return time.Time{}, errors.New("sent_at is not a UTC minute such as 2026-03-14T18:22:00Z")
	}
	if capturedAt, err := time.Parse(time.RFC3339, l.CapturedAt); err != nil || capturedAt.Location() != time.UTC {
		return time.Time{}, errors.New("captured_at is not a UTC time")
	}
	return sentAt, nil
}

func (a *Attachment) validate() error {
	switch {
	case !attachmentFile.MatchString(a.File) || strings.HasSuffix(a.File, FileExtension):
		return errors.New("file is not a plain file name in the capture folder")
	case imageExtensions[a.MIMEType] == "":
		return errors.New("mime_type is not a supported image type")
	case a.Size < 1 || a.Size > MaxAttachmentBytes:
		return fmt.Errorf("size is not between 1 and %d bytes", MaxAttachmentBytes)
	case !hexSHA256.MatchString(a.SHA256):
		return errors.New("sha256 is not a lowercase hex SHA-256")
	}
	return nil
}

// LoadAttachments reads every image the messages list from dir into their
// Content, checking each file's size, hash, and type against its listing.
// The error names the message by its line.
func LoadAttachments(dir string, messages []Message) error {
	for n := range messages {
		msg := &messages[n]
		msg.Content = make([][]byte, len(msg.Attachments))
		for k, a := range msg.Attachments {
			data, err := readAttachment(filepath.Join(dir, a.File), a)
			if err != nil {
				return &LineError{Line: n + 1, Err: fmt.Errorf("attachment %d: %w", k, err)}
			}
			msg.Content[k] = data
		}
	}
	return nil
}

func readAttachment(path string, a Attachment) ([]byte, error) {
	info, err := os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil, errors.New("file is missing")
	}
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() {
		return nil, errors.New("file is not a regular file")
	}
	if info.Size() != a.Size {
		return nil, errors.New("file size does not match size")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	sum := sha256.Sum256(data)
	if int64(len(data)) != a.Size || hex.EncodeToString(sum[:]) != a.SHA256 {
		return nil, errors.New("file content does not match sha256")
	}
	if sniffImage(data) != a.MIMEType {
		return nil, errors.New("file content is not of its mime_type")
	}
	return data, nil
}

func printable(s string) bool {
	if !utf8.ValidString(s) {
		return false
	}
	for _, r := range s {
		if unicode.IsControl(r) {
			return false
		}
	}
	return true
}

// DiscoverFiles lists the finished capture files directly inside dir,
// oldest name first. Capture tools name files by UTC time, so name order is
// capture order. Hidden files, subfolders, and anything that is not a
// regular file are skipped.
func DiscoverFiles(dir string) ([]string, error) {
	info, err := os.Stat(dir)
	if err != nil {
		return nil, err
	}
	if !info.IsDir() {
		return nil, fmt.Errorf("%s is not a folder", dir)
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	var files []string
	for _, entry := range entries {
		name := entry.Name()
		if strings.HasPrefix(name, ".") || !strings.HasSuffix(name, FileExtension) {
			continue
		}
		if !entry.Type().IsRegular() {
			continue
		}
		files = append(files, filepath.Join(dir, name))
	}
	slices.Sort(files)
	return files, nil
}
