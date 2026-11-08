package gmessagesweb

import (
	"encoding/json/v2"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestParseRejectsInvalidLines(t *testing.T) {
	direct := []string{ownerPhone, alice}
	tests := []struct {
		name   string
		mutate func(*Line)
		want   string
	}{
		{"short message id", func(l *Line) { l.MessageID = "abc" }, "message_id is not a lowercase hex SHA-256"},
		{"uppercase conversation id", func(l *Line) { l.ConversationID = strings.ToUpper(l.ConversationID) }, "conversation_id is not"},
		{"one participant", func(l *Line) { l.Participants = []string{ownerPhone} }, "participants has 1 entries"},
		{"unsorted participants", func(l *Line) { l.Participants = []string{alice, ownerPhone} }, "participants are not sorted and distinct"},
		{"repeated participant", func(l *Line) { l.Participants = []string{ownerPhone, ownerPhone} }, "participants are not sorted and distinct"},
		{"short code participant", func(l *Line) { l.Participants = []string{"+12345", ownerPhone} }, "participant 0 is not an E.164 number"},
		{"sender outside conversation", func(l *Line) { l.Sender = bob }, "sender is not a participant"},
		{"owner outside conversation", func(l *Line) { l.Participants = []string{alice, bob} }, "owner phone is not a participant"},
		{"seconds in sent_at", func(l *Line) { l.SentAt = "2026-03-14T18:22:05Z" }, "sent_at is not a UTC minute"},
		{"offset in sent_at", func(l *Line) { l.SentAt = "2026-03-14T18:22:00-07:00" }, "sent_at is not a UTC minute"},
		{"other precision", func(l *Line) { l.SentAtPrecision = "second" }, "sent_at_precision is not"},
		{"attachment in another folder", func(l *Line) { l.Attachments = []Attachment{image("../a-1.png")} }, "attachment 0: file is not a plain file name"},
		{"hidden attachment", func(l *Line) { l.Attachments = []Attachment{image(".a-1.png")} }, "attachment 0: file is not a plain file name"},
		{"attachment named as a capture file", func(l *Line) { l.Attachments = []Attachment{image("b.jsonl")} }, "attachment 0: file is not a plain file name"},
		{"attachment of another type", func(l *Line) {
			a := image("a-1.svg")
			a.MIMEType = "image/svg+xml"
			l.Attachments = []Attachment{a}
		}, "attachment 0: mime_type is not a supported image type"},
		{"empty attachment", func(l *Line) {
			a := image("a-1.png")
			a.Size = 0
			l.Attachments = []Attachment{a}
		}, "attachment 0: size is not between"},
		{"attachment without hash", func(l *Line) {
			a := image("a-1.png")
			a.SHA256 = ""
			l.Attachments = []Attachment{a}
		}, "attachment 0: sha256 is not"},
		{"too many attachments", func(l *Line) {
			for range MaxAttachments + 1 {
				l.Attachments = append(l.Attachments, image("a-1.png"))
			}
		}, "attachments has more than"},
		{"control character in page id", func(l *Line) { l.PageMessageID = "1\n2" }, "page_message_id is not printable"},
		{"local captured_at", func(l *Line) { l.CapturedAt = "2026-03-14T18:25:31+01:00" }, "captured_at is not a UTC time"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			l := line("p1", direct, alice, "2026-03-14T18:22:00Z", "hello")
			tt.mutate(&l)
			data, err := json.Marshal(l)
			require.NoError(t, err, "marshal line")
			_, err = Parse(strings.NewReader(string(data)+"\n"), ownerPhone)
			require.Error(t, err)
			assert.ErrorContains(t, err, "line 1: "+tt.want)
		})
	}
}

func TestParseRejectsMalformedFiles(t *testing.T) {
	valid, err := json.Marshal(line("p1", []string{ownerPhone, alice}, alice, "2026-03-14T18:22:00Z", "hello"))
	require.NoError(t, err, "marshal line")
	tests := []struct {
		name string
		body string
		want string
	}{
		{"empty file", "", "file has no messages"},
		{"blank line", string(valid) + "\n\n", "line 2: not a capture record"},
		{"unknown field", strings.Replace(string(valid), `{`, `{"extra":1,`, 1) + "\n", "line 1: not a capture record"},
		{"attachments null", strings.Replace(string(valid), `"attachments":[]`, `"attachments":null`, 1) + "\n", "line 1: attachments is missing"},
		{"attachments absent", strings.Replace(string(valid), `"attachments":[],`, ``, 1) + "\n", "line 1: attachments is missing"},
		{"two records on one line", string(valid) + string(valid) + "\n", "line 1: not a capture record"},
		{"truncated line", string(valid[:len(valid)/2]), "line 1: not a capture record"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := Parse(strings.NewReader(tt.body), ownerPhone)
			require.Error(t, err)
			assert.ErrorContains(t, err, tt.want)
		})
	}
}

func TestParseKeepsRawLine(t *testing.T) {
	require := require.New(t)
	assert := assert.New(t)
	data, err := json.Marshal(line("p1", []string{ownerPhone, alice}, alice, "2026-03-14T18:22:00Z", "hello"))
	require.NoError(err, "marshal line")
	messages, err := Parse(strings.NewReader(string(data)+"\n"), ownerPhone)
	require.NoError(err, "Parse")
	require.Len(messages, 1)
	assert.Equal(string(data), string(messages[0].Raw))
	assert.Equal("hello", messages[0].Text)
}

func TestDiscoverFilesListsFinishedCaptureFilesInNameOrder(t *testing.T) {
	require := require.New(t)
	assert := assert.New(t)
	dir := t.TempDir()
	for _, name := range []string{"b.jsonl", "a.jsonl", ".incoming-1.tmp", ".hidden.jsonl", "notes.txt"} {
		require.NoError(os.WriteFile(filepath.Join(dir, name), []byte("{}\n"), 0o600), "write %s", name)
	}
	require.NoError(os.Mkdir(filepath.Join(dir, "sub.jsonl"), 0o700), "make folder")
	target := filepath.Join(t.TempDir(), "elsewhere.jsonl")
	require.NoError(os.WriteFile(target, []byte("{}\n"), 0o600), "write symlink target")
	require.NoError(os.Symlink(target, filepath.Join(dir, "c.jsonl")), "make symlink")

	files, err := DiscoverFiles(dir)
	require.NoError(err, "DiscoverFiles")
	assert.Equal([]string{filepath.Join(dir, "a.jsonl"), filepath.Join(dir, "b.jsonl")}, files)
}

func image(file string) Attachment {
	return Attachment{File: file, MIMEType: "image/png", Size: 10, SHA256: hashOf("image")}
}
