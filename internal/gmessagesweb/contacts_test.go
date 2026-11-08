package gmessagesweb

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.kenn.io/msgvault/internal/store"
	"go.kenn.io/msgvault/internal/testutil/storetest"
)

// writeContacts writes a vCard 3.0 file, the format Google Contacts exports,
// with one card per name and number pair. An empty name writes a card
// without FN.
func writeContacts(t *testing.T, cards ...[2]string) string {
	t.Helper()
	var b strings.Builder
	for _, card := range cards {
		b.WriteString("BEGIN:VCARD\r\nVERSION:3.0\r\n")
		if card[0] != "" {
			b.WriteString("FN:" + card[0] + "\r\n")
		}
		b.WriteString("TEL;TYPE=CELL:" + card[1] + "\r\nEND:VCARD\r\n")
	}
	path := filepath.Join(t.TempDir(), "contacts.vcf")
	require.NoError(t, os.WriteFile(path, []byte(b.String()), 0o600), "write contacts")
	return path
}

func participantNames(t *testing.T, st *store.Store) map[string]string {
	t.Helper()
	rows, err := st.DB().QueryContext(t.Context(),
		`SELECT phone_number, COALESCE(display_name, '') FROM participants WHERE phone_number IS NOT NULL AND phone_number != ''`)
	require.NoError(t, err, "query participants")
	defer func() { _ = rows.Close() }()
	names := map[string]string{}
	for rows.Next() {
		var phone, name string
		require.NoError(t, rows.Scan(&phone, &name), "scan participant")
		names[phone] = name
	}
	require.NoError(t, rows.Err(), "iterate participants")
	return names
}

func TestApplyContactsNamesParticipantsByPhone(t *testing.T) {
	require := require.New(t)
	assert := assert.New(t)
	f := storetest.New(t)
	dir := t.TempDir()
	writeCapture(t, filepath.Join(dir, "20260315T090131.000000000Z-0e0f1011.jsonl"), groupLines()...)
	_, err := newImporter(f).ImportDir(t.Context(), dir)
	require.NoError(err, "ImportDir")

	contacts := writeContacts(t,
		// A US number without a country code, as address books often hold it.
		[2]string{"Alice Example", "(555) 555-0101"},
		[2]string{"Bob Example", "+1 555-555-0142"},
		// Nobody in the archive has this number.
		[2]string{"Carol Example", "+1 555-555-0199"},
		// A card without a name names nobody and is not counted.
		[2]string{"", "+1 555-555-0101"},
	)
	summary, err := ApplyContacts(t.Context(), f.Store, contacts)
	require.NoError(err, "ApplyContacts")
	assert.Equal(ContactsSummary{Contacts: 3, Named: 2}, summary)
	assert.Equal(map[string]string{
		ownerPhone: "Me",
		alice:      "Alice Example",
		bob:        "Bob Example",
	}, participantNames(t, f.Store))
}

func TestApplyContactsKeepsExistingNames(t *testing.T) {
	require := require.New(t)
	assert := assert.New(t)
	f := storetest.New(t)
	dir := t.TempDir()
	writeCapture(t, filepath.Join(dir, "20260314T182531.000000000Z-0a0b0c0d.jsonl"), directLines()...)
	_, err := newImporter(f).ImportDir(t.Context(), dir)
	require.NoError(err, "ImportDir")

	_, err = ApplyContacts(t.Context(), f.Store, writeContacts(t, [2]string{"Alice Example", "+15555550101"}))
	require.NoError(err, "first ApplyContacts")
	summary, err := ApplyContacts(t.Context(), f.Store, writeContacts(t,
		[2]string{"Alice Renamed", "+15555550101"},
		[2]string{"Not The Owner", ownerPhone},
	))
	require.NoError(err, "second ApplyContacts")
	assert.Equal(ContactsSummary{Contacts: 2, Named: 0}, summary)
	assert.Equal(map[string]string{ownerPhone: "Me", alice: "Alice Example"}, participantNames(t, f.Store))
}

func TestApplyContactsRejectsMissingFile(t *testing.T) {
	f := storetest.New(t)
	_, err := ApplyContacts(t.Context(), f.Store, filepath.Join(t.TempDir(), "missing.vcf"))
	require.Error(t, err)
	assert.ErrorContains(t, err, "read contacts")
}
