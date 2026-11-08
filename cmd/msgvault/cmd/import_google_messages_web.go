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
	cmd := &cobra.Command{
		Use:   "import-google-messages-web <folder>",
		Short: "Import conversations captured from Google Messages for web",
		Long: `Import every capture file in a folder of conversations captured from
Google Messages for web. Each file is deleted once all of its messages are
stored. A file that fails to import stays in the folder and is named in the
error, and the remaining files are still imported.`,
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
				return runDaemonCLICommandHTTPFromCobra(cmd, args)
			}
			st, cleanup, err := openWritableStoreAndInitForIngestInvocation(cmd.Context(), state)
			if err != nil {
				return err
			}
			defer cleanup()
			summary, err := importGoogleMessagesWeb(cmd.Context(), st, args[0], opts.OwnerPhone, opts.OwnerPhone)
			cmd.Printf("Imported %d messages from %d of %d files\n",
				summary.MessagesImported, summary.FilesImported, summary.FilesSeen)
			return err
		},
	}
	cmd.Flags().StringVar(&opts.OwnerPhone, "owner-phone", "", "Owner phone number in E.164 format")
	return cmd
}

// importGoogleMessagesWeb runs one import of dir and, once anything is
// stored, records the owner's number as their identity for the source.
func importGoogleMessagesWeb(ctx context.Context, st *store.Store, dir, ownerPhone, name string) (gmessagesweb.ImportSummary, error) {
	summary, err := gmessagesweb.NewImporter(st, gmessagesweb.ImportOptions{OwnerPhone: ownerPhone}).ImportDir(ctx, dir)
	if summary.MessagesImported == 0 {
		return summary, err
	}
	state := invocationFromContext(ctx)
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
	if err != nil {
		err = fmt.Errorf("google-messages-web source %q: %w", src.Name, err)
	}
	if state := invocationFromContext(ctx); state != nil && state.logger != nil {
		state.logger.Info("google-messages-web import finished", "source", src.Name,
			"files", summary.FilesImported, "failed_files", summary.FilesFailed, "messages", summary.MessagesImported)
	}
	return recordSyncAttempt(ctx, gmessagesweb.SourceType, src.OwnerPhone, err)
}

func init() {
	rootCmd.AddCommand(newImportGoogleMessagesWebCmd())
}
