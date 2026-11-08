package gmessagesweb

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json/jsontext"
	"encoding/json/v2"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.kenn.io/msgvault/internal/store"
	"go.kenn.io/msgvault/internal/testutil/storetest"
)

const (
	ownerPhone = "+15555550100"
	alice      = "+15555550101"
	bob        = "+15555550142"
)

func hashOf(s string) string {
	sum := sha256.Sum256([]byte(s))
	return hex.EncodeToString(sum[:])
}

// line builds a valid capture record. The IDs are hashes of made-up keys;
// the importer takes them as given and does not recompute them.
func line(key string, participants []string, sender, sentAt, text string) Line {
	return Line{
		MessageID:       hashOf("message:" + key),
		ConversationID:  hashOf("conversation:" + strings.Join(participants, ",")),
		Participants:    participants,
		Sender:          sender,
		SentAt:          sentAt,
		SentAtPrecision: SentAtPrecisionMinute,
		Text:            text,
		Attachments:     []jsontext.Value{},
		CapturedAt:      "2026-03-14T18:25:31Z",
		PageMessageID:   "101",
	}
}

func writeCapture(t *testing.T, path string, lines ...Line) {
	t.Helper()
	var b strings.Builder
	for _, l := range lines {
		data, err := json.Marshal(l)
		require.NoError(t, err, "marshal line")
		b.Write(data)
		b.WriteByte('\n')
	}
	require.NoError(t, os.WriteFile(path, []byte(b.String()), 0o600), "write capture file")
}

func directLines() []Line {
	direct := []string{ownerPhone, alice}
	return []Line{
		line("d1", direct, alice, "2026-03-14T18:22:00Z", "Running ten minutes late"),
		line("d2", direct, ownerPhone, "2026-03-14T18:23:00Z", "No problem"),
		// Two identical texts in one minute carry different IDs.
		line("d3", direct, alice, "2026-03-14T18:24:00Z", "ok"),
		line("d4", direct, alice, "2026-03-14T18:24:00Z", "ok"),
	}
}

func groupLines() []Line {
	group := []string{ownerPhone, alice, bob}
	return []Line{
		line("g1", group, bob, "2026-03-15T09:00:00Z", "Dinner at seven?"),
		line("g2", group, ownerPhone, "2026-03-15T09:01:00Z", "Works for me"),
	}
}

func newImporter(f *storetest.Fixture) *Importer {
	return NewImporter(f.Store, ImportOptions{OwnerPhone: ownerPhone})
}

func TestImportDirStoresMessagesAndDeletesFiles(t *testing.T) {
	require := require.New(t)
	assert := assert.New(t)
	f := storetest.New(t)
	dir := t.TempDir()
	writeCapture(t, filepath.Join(dir, "20260314T182531.000000000Z-0a0b0c0d.jsonl"), directLines()...)
	writeCapture(t, filepath.Join(dir, "20260315T090131.000000000Z-0e0f1011.jsonl"), groupLines()...)

	summary, err := newImporter(f).ImportDir(t.Context(), dir)
	require.NoError(err, "ImportDir")
	assert.Equal(ImportSummary{FilesSeen: 2, FilesImported: 2, MessagesImported: 6}, withoutIDs(summary))
	assertMessageCount(t, f.Store, 6)
	assertConversations(t, f.Store, map[string]int{"direct_chat": 1, "group_chat": 1})
	assertRawFormats(t, f.Store, 6)
	assertFolderEmpty(t, dir)
}

func TestImportDirTwiceAddsNothing(t *testing.T) {
	require := require.New(t)
	assert := assert.New(t)
	f := storetest.New(t)
	dir := t.TempDir()
	imp := newImporter(f)
	writeCapture(t, filepath.Join(dir, "a.jsonl"), directLines()...)
	_, err := imp.ImportDir(t.Context(), dir)
	require.NoError(err, "first ImportDir")

	// A second capture of the same thread loads the same messages again,
	// along with one new one.
	again := append(directLines(), line("d5", []string{ownerPhone, alice}, alice, "2026-03-14T18:30:00Z", "Here"))
	writeCapture(t, filepath.Join(dir, "b.jsonl"), again...)
	summary, err := imp.ImportDir(t.Context(), dir)
	require.NoError(err, "second ImportDir")
	assert.Equal(5, summary.MessagesImported, "messages written in the second run")
	assertMessageCount(t, f.Store, 5)
	assertConversations(t, f.Store, map[string]int{"direct_chat": 1})
	assertFolderEmpty(t, dir)
}

func TestImportDirRecordsSenderRecipientsAndTime(t *testing.T) {
	require := require.New(t)
	assert := assert.New(t)
	f := storetest.New(t)
	dir := t.TempDir()
	writeCapture(t, filepath.Join(dir, "a.jsonl"), groupLines()...)
	_, err := newImporter(f).ImportDir(t.Context(), dir)
	require.NoError(err, "ImportDir")

	type row struct {
		sourceMessageID string
		messageType     string
		fromMe          bool
		sentAt          time.Time
		sender          string
		recipients      int
	}
	read := func(sourceMessageID string) row {
		var r row
		err := f.Store.DB().QueryRowContext(t.Context(), f.Store.Rebind(`
			SELECT m.source_message_id, m.message_type, m.is_from_me, m.sent_at, p.phone_number,
			       (SELECT COUNT(*) FROM message_recipients r WHERE r.message_id = m.id AND r.recipient_type = 'to')
			FROM messages m JOIN participants p ON p.id = m.sender_id
			WHERE m.source_message_id = ?`), sourceMessageID).
			Scan(&r.sourceMessageID, &r.messageType, &r.fromMe, &r.sentAt, &r.sender, &r.recipients)
		require.NoError(err, "read message")
		return r
	}
	lines := groupLines()
	incoming := read(lines[0].MessageID)
	assert.Equal(MessageType, incoming.messageType)
	assert.False(incoming.fromMe, "incoming is_from_me")
	assert.Equal(bob, incoming.sender)
	assert.Equal(2, incoming.recipients, "incoming recipients")
	assert.True(time.Date(2026, 3, 15, 9, 0, 0, 0, time.UTC).Equal(incoming.sentAt), "sent_at = %v", incoming.sentAt)

	outgoing := read(lines[1].MessageID)
	assert.True(outgoing.fromMe, "outgoing is_from_me")
	assert.Equal(ownerPhone, outgoing.sender)
	assert.Equal(2, outgoing.recipients, "outgoing recipients")
}

func TestImportDirLeavesFailedFileAndImportsTheRest(t *testing.T) {
	require := require.New(t)
	assert := assert.New(t)
	f := storetest.New(t)
	dir := t.TempDir()
	bad := line("x1", []string{alice, bob}, alice, "2026-03-14T18:22:00Z", "not mine")
	badPath := filepath.Join(dir, "a.jsonl")
	writeCapture(t, badPath, directLines()[0], bad)
	writeCapture(t, filepath.Join(dir, "b.jsonl"), groupLines()...)

	summary, err := newImporter(f).ImportDir(t.Context(), dir)
	require.Error(err, "ImportDir")
	require.ErrorContains(err, "capture file a.jsonl: line 2: owner phone is not a participant")
	assert.NotContains(err.Error(), alice, "errors must not carry phone numbers")
	assert.Equal(ImportSummary{FilesSeen: 2, FilesImported: 1, FilesFailed: 1, MessagesImported: 2}, withoutIDs(summary))
	// No line of a file that fails to parse is stored.
	assertMessageCount(t, f.Store, 2)
	assert.FileExists(badPath, "failed file stays for the next run")
	assert.NoFileExists(filepath.Join(dir, "b.jsonl"), "imported file is deleted")

	var status string
	require.NoError(f.Store.DB().QueryRowContext(t.Context(),
		`SELECT status FROM sync_runs ORDER BY id DESC LIMIT 1`).Scan(&status), "read sync run")
	assert.Equal("failed", status)
}

func TestImportDirRequiresOwnerPhone(t *testing.T) {
	f := storetest.New(t)
	for _, owner := range []string{"", "5555550100"} {
		_, err := NewImporter(f.Store, ImportOptions{OwnerPhone: owner}).ImportDir(t.Context(), t.TempDir())
		require.Error(t, err, "owner %q", owner)
		assert.ErrorContains(t, err, "owner phone in E.164 format is required")
	}
}

func TestImportDirRejectsMissingFolder(t *testing.T) {
	f := storetest.New(t)
	_, err := newImporter(f).ImportDir(t.Context(), filepath.Join(t.TempDir(), "missing"))
	require.Error(t, err)
	assert.ErrorContains(t, err, "read capture folder")
}

func withoutIDs(s ImportSummary) ImportSummary {
	s.MessageIDs = nil
	return s
}

func assertMessageCount(t *testing.T, st *store.Store, want int) {
	t.Helper()
	var got int
	require.NoError(t, st.DB().QueryRowContext(t.Context(), st.Rebind(
		`SELECT COUNT(*) FROM messages WHERE message_type = ?`), MessageType).Scan(&got), "count messages")
	assert.Equal(t, want, got, "message count")
}

func assertRawFormats(t *testing.T, st *store.Store, want int) {
	t.Helper()
	var got int
	require.NoError(t, st.DB().QueryRowContext(t.Context(), st.Rebind(
		`SELECT COUNT(*) FROM message_raw WHERE raw_format = ?`), RawFormat).Scan(&got), "count raw records")
	assert.Equal(t, want, got, "raw record count")
}

func assertConversations(t *testing.T, st *store.Store, want map[string]int) {
	t.Helper()
	rows, err := st.DB().QueryContext(t.Context(), st.Rebind(`
		SELECT c.conversation_type, COUNT(*) FROM conversations c
		JOIN sources s ON s.id = c.source_id
		WHERE s.source_type = ?
		GROUP BY c.conversation_type`), SourceType)
	require.NoError(t, err, "count conversations")
	defer func() { _ = rows.Close() }()
	got := map[string]int{}
	for rows.Next() {
		var kind string
		var n int
		require.NoError(t, rows.Scan(&kind, &n), "scan conversation count")
		got[kind] = n
	}
	require.NoError(t, rows.Err(), "conversation rows")
	assert.Equal(t, want, got, "conversations by type")
}

func assertFolderEmpty(t *testing.T, dir string) {
	t.Helper()
	entries, err := os.ReadDir(dir)
	require.NoError(t, err, "read folder")
	assert.Empty(t, entries, "capture folder")
}
