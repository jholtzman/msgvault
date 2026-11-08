// Package gmessagesweb imports conversations captured from Google Messages
// for web. A capture tool writes each batch of messages it reads from the
// page as one JSON Lines file in a folder, with each image in a file of its
// own beside it. The importer stores every message in the folder and deletes
// each batch's files once all of its messages are stored.
//
// Message and conversation IDs come from the file. The capture tool derives
// them from what the page shows, so capturing a thread again produces the
// same IDs and the import adds nothing new.
package gmessagesweb

import "time"

const (
	AdapterName = "google-messages-web"
	SourceType  = "google_messages_web"
	// MessageType is written to messages.message_type. Messages for web
	// carries SMS, MMS, and RCS, and the capture file does not say which.
	MessageType               = "google_messages_web"
	ParticipantIdentifierType = "google_messages_web"
	RawFormat                 = "google_messages_web_jsonl"

	// FileExtension marks a finished capture file. Files whose names start
	// with a dot are still being written and are skipped.
	FileExtension = ".jsonl"

	// SentAtPrecisionMinute is the only precision Messages for web shows.
	SentAtPrecisionMinute = "minute"
)

// Line is one message in a capture file. Every field is required.
type Line struct {
	// MessageID is the lowercase hex SHA-256 the capture tool derived for
	// the message. It becomes the message's source message ID.
	MessageID string `json:"message_id"`
	// ConversationID is the lowercase hex SHA-256 of the conversation's
	// sorted participant numbers.
	ConversationID string `json:"conversation_id"`
	// Participants are the conversation's E.164 numbers, sorted, including
	// the owner's.
	Participants []string `json:"participants"`
	// Sender is the E.164 number of whoever sent the message.
	Sender string `json:"sender"`
	// SentAt is a UTC time at SentAtPrecision.
	SentAt          string `json:"sent_at"`
	SentAtPrecision string `json:"sent_at_precision"`
	Text            string `json:"text"`
	// Attachments are the message's images, each a file beside the capture
	// file. The list is empty for a message without images.
	Attachments []Attachment `json:"attachments"`
	// CapturedAt is when the capture tool read the message.
	CapturedAt string `json:"captured_at"`
	// PageMessageID is the page's own ID for the message, kept in the raw
	// record for diagnosis only.
	PageMessageID string `json:"page_message_id"`
}

// Attachment is one image of a message, stored in a file of its own in the
// capture folder.
type Attachment struct {
	// File is the image file's name, directly inside the capture folder.
	File     string `json:"file"`
	MIMEType string `json:"mime_type"`
	// Size and SHA256 are checked against the file before it is stored.
	Size   int64  `json:"size"`
	SHA256 string `json:"sha256"`
}

// Message is a validated Line with its times parsed and the raw line kept.
type Message struct {
	Line

	SentAtTime time.Time
	Raw        []byte
	// Content holds each attachment's bytes, in order, once LoadAttachments
	// has read and checked them.
	Content [][]byte
}

type ImportOptions struct {
	// OwnerPhone is the archive owner's E.164 number. It must be one of
	// every message's participants.
	OwnerPhone string
	// AttachmentsDir is the archive's attachment store. It is required to
	// import a capture file that lists images.
	AttachmentsDir string
}

type ImportSummary struct {
	FilesSeen        int
	FilesImported    int
	FilesFailed      int
	MessagesImported int
	ImagesImported   int
	// MessageIDs are the archive IDs of messages written in this run,
	// including messages from files that later failed.
	MessageIDs []int64
}
