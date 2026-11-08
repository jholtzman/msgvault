package cmd

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.kenn.io/msgvault/internal/config"
	"go.kenn.io/msgvault/internal/gmessagesweb"
	"go.kenn.io/msgvault/internal/store"
)

// googleMessagesWebCapture is one made-up capture line between the owner,
// +15555550100, and +15555550101.
const googleMessagesWebCapture = `{"message_id":"9f2c000000000000000000000000000000000000000000000000000000000001",` +
	`"conversation_id":"41ab000000000000000000000000000000000000000000000000000000000001",` +
	`"participants":["+15555550100","+15555550101"],"sender":"+15555550101",` +
	`"sent_at":"2026-03-14T18:22:00Z","sent_at_precision":"minute","text":"Running ten minutes late",` +
	`"attachments":[],"captured_at":"2026-03-14T18:25:31Z","page_message_id":"101"}` + "\n"

func TestImportGoogleMessagesWebRequiresOwnerPhone(t *testing.T) {
	cfg := config.NewDefaultConfig()
	cfg.HomeDir = t.TempDir()
	cfg.Data.DataDir = cfg.HomeDir
	cmd := newTestRootCmd()
	cmd.SetContext(testInvocationContext(t.Context(), cfg, invocationOptions{}))
	cmd.AddCommand(newImportGoogleMessagesWebCmd())
	cmd.SetArgs([]string{"import-google-messages-web", t.TempDir()})
	err := cmd.Execute()
	require.Error(t, err)
	assert.ErrorContains(t, err, "--owner-phone is required")
}

func TestImportGoogleMessagesWebCommandImportsAndDeletes(t *testing.T) {
	require := require.New(t)
	assert := assert.New(t)
	markDaemonCLISubprocessForTest(t)

	home := t.TempDir()
	folder := t.TempDir()
	capture := filepath.Join(folder, "20260314T182531.000000000Z-0a0b0c0d.jsonl")
	require.NoError(os.WriteFile(capture, []byte(googleMessagesWebCapture), 0o600), "write capture")
	cfg := config.NewDefaultConfig()
	cfg.HomeDir = home
	cfg.Data.DataDir = home
	cmd := newTestRootCmd()
	cmd.SetContext(testInvocationContext(t.Context(), cfg, invocationOptions{}))
	cmd.AddCommand(newImportGoogleMessagesWebCmd())
	cmd.SetArgs([]string{"import-google-messages-web", "--owner-phone", "+15555550100", folder})
	require.NoError(cmd.Execute(), "Execute")
	assert.NoFileExists(capture, "imported capture file is deleted")

	st, err := store.Open(cfg.DatabaseDSN())
	require.NoError(err, "open store")
	t.Cleanup(func() { _ = st.Close() })
	var count int
	require.NoError(st.DB().QueryRowContext(t.Context(), st.Rebind(
		`SELECT COUNT(*) FROM messages WHERE message_type = ?`), gmessagesweb.MessageType).Scan(&count), "count messages")
	assert.Equal(1, count, "imported messages")
}
