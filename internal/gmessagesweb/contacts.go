package gmessagesweb

import (
	"context"
	"fmt"

	"go.kenn.io/msgvault/internal/store"
	"go.kenn.io/msgvault/internal/vcard"
)

// ContactsSummary reports one ApplyContacts run.
type ContactsSummary struct {
	// Contacts counts the vCard entries that have a name.
	Contacts int
	// Named counts the contacts whose name filled at least one participant.
	Named int
}

// ApplyContacts reads a vCard file and gives each participant that has one
// of a contact's phone numbers and no name yet that contact's name. Capture
// files carry only phone numbers, so a contacts export is how their
// participants get names. It reads the file and changes nothing else: a name
// another source already set is kept, no participant is created, and email
// addresses are ignored because this source has none. The vCard reader turns
// numbers such as "(415) 555-0123" into E.164, assuming the US for ten-digit
// numbers, so they match the numbers capture files carry.
func ApplyContacts(ctx context.Context, st *store.Store, path string) (ContactsSummary, error) {
	contacts, err := vcard.ParseFile(path)
	if err != nil {
		return ContactsSummary{}, fmt.Errorf("read contacts: %w", err)
	}
	var summary ContactsSummary
	for n, contact := range contacts {
		if contact.FullName == "" {
			continue
		}
		summary.Contacts++
		named := false
		for _, phone := range contact.Phones {
			updated, err := st.UpdateParticipantDisplayNameByPhone(ctx, phone, contact.FullName)
			if err != nil {
				// The contact's position, not its name or number, keeps
				// personal data out of logs and sync errors.
				return summary, fmt.Errorf("name participants from contact %d: %w", n+1, err)
			}
			named = named || updated
		}
		if named {
			summary.Named++
		}
	}
	return summary, nil
}
