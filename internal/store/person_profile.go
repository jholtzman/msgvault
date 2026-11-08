package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"
)

type PersonProfile struct {
	Person        Person               `json:"person"`
	Names         []PersonName         `json:"names"`
	ContactPoints []PersonContactPoint `json:"contact_points"`
	Addresses     []PersonAddress      `json:"addresses"`
	Dates         []PersonDate         `json:"dates"`
	Categories    []PersonCategory     `json:"categories"`
	Media         []PersonMedia        `json:"media"`
}

type PersonProfilePatch struct {
	Names         *PersonNamePatch         `json:"names,omitzero" nullable:"false"`
	ContactPoints *PersonContactPointPatch `json:"contact_points,omitzero" nullable:"false"`
	Addresses     *PersonAddressPatch      `json:"addresses,omitzero" nullable:"false"`
	Dates         *PersonDatePatch         `json:"dates,omitzero" nullable:"false"`
	Categories    *PersonCategoryPatch     `json:"categories,omitzero" nullable:"false"`
	Media         *PersonMediaPatch        `json:"media,omitzero" nullable:"false"`
}

type PersonNamePatch struct {
	Add       []PersonNameInput `json:"add,omitempty"`
	Supersede []int64           `json:"supersede,omitempty"`
}

type PersonContactPointPatch struct {
	Add       []PersonContactPointInput `json:"add,omitempty"`
	Supersede []int64                   `json:"supersede,omitempty"`
}

type PersonAddressPatch struct {
	Add       []PersonAddressInput `json:"add,omitempty"`
	Supersede []int64              `json:"supersede,omitempty"`
}

type PersonDatePatch struct {
	Add       []PersonDateInput `json:"add,omitempty"`
	Supersede []int64           `json:"supersede,omitempty"`
}

type PersonCategoryPatch struct {
	Add       []PersonCategoryInput `json:"add,omitempty"`
	Supersede []int64               `json:"supersede,omitempty"`
}

type PersonMediaPatch struct {
	Add       []PersonMediaInput `json:"add,omitempty"`
	Supersede []int64            `json:"supersede,omitempty"`
}

type PersonProfileHistory struct {
	Person        Person                          `json:"person"`
	Names         []PersonName                    `json:"names"`
	ContactPoints []PersonContactPoint            `json:"contact_points"`
	Addresses     []PersonAddress                 `json:"addresses"`
	Dates         []PersonDate                    `json:"dates"`
	Categories    []PersonCategory                `json:"categories"`
	Media         []PersonMedia                   `json:"media"`
	Observations  []ParticipantContactObservation `json:"observations"`
	MergedIn      []PersonMergedInParticipant     `json:"merged_in"`
}

// PersonMergedInParticipant is the latest unsplit merge that brought a current member in.
type PersonMergedInParticipant struct {
	MergeID       int64                          `json:"merge_id"`
	ParticipantID int64                          `json:"participant_id"`
	MergedAt      time.Time                      `json:"merged_at"`
	Member        PersonClusterMember            `json:"member"`
	Identifiers   []ParticipantIdentifierContext `json:"identifiers"`
}

const MaxPersonProfilePatchOperations = 200

var (
	ErrPersonProfilePatchTooLarge = errors.New("person profile patch exceeds the operation limit")
	ErrPersonProfilePatchEmpty    = errors.New("person profile patch contains no operations")
)

func (s *Store) GetPersonProfileContext(
	ctx context.Context, personID int64,
) (*PersonProfile, error) {
	var profile *PersonProfile
	err := s.withReadSnapshotContext(ctx, func(tx *loggedTx) error {
		var err error
		profile, err = s.getPersonProfileTx(ctx, tx, personID, true)
		return err
	})
	return profile, err
}

func (s *Store) ApplyPersonProfilePatchContext(
	ctx context.Context,
	personID, expectedRevision int64,
	patch PersonProfilePatch,
) (*PersonProfile, error) {
	operations := countPersonProfilePatchOperations(patch)
	if operations == 0 {
		return nil, ErrPersonProfilePatchEmpty
	}
	if operations > MaxPersonProfilePatchOperations {
		return nil, ErrPersonProfilePatchTooLarge
	}
	var profile *PersonProfile
	err := s.withTxContext(ctx, func(tx *loggedTx) error {
		if err := s.lockIdentityMutationTxContext(ctx, tx); err != nil {
			return err
		}
		var updatedID int64
		err := tx.QueryRowContext(ctx, `UPDATE persons
			SET revision = revision + 1,
			    vcard_projection_revision = vcard_projection_revision + 1,
			    updated_at = `+s.dialect.Now()+`
			WHERE id = ? AND revision = ? RETURNING id`,
			personID, expectedRevision,
		).Scan(&updatedID)
		if errors.Is(err, sql.ErrNoRows) {
			return s.personCASMissTx(ctx, tx, personID)
		}
		if err != nil {
			return fmt.Errorf("update person profile revision: %w", err)
		}
		if err := s.applyPersonProfilePatchTx(ctx, tx, personID, patch); err != nil {
			return err
		}
		if personProfilePatchChangesEnrichmentIdentity(patch) {
			if err := s.invalidatePersonEnrichmentIdentitiesAfterRevisionTx(
				ctx, tx, personID); err != nil {
				return err
			}
		}
		profile, err = s.getPersonProfileTx(ctx, tx, updatedID, true)
		return err
	})
	return profile, err
}

func personProfilePatchChangesEnrichmentIdentity(patch PersonProfilePatch) bool {
	namesChanged := patch.Names != nil &&
		(len(patch.Names.Add) > 0 || len(patch.Names.Supersede) > 0)
	contactsChanged := patch.ContactPoints != nil &&
		(len(patch.ContactPoints.Add) > 0 || len(patch.ContactPoints.Supersede) > 0)
	return namesChanged || contactsChanged
}

func (s *Store) GetPersonProfileHistoryContext(
	ctx context.Context, personID int64,
) (*PersonProfileHistory, error) {
	var history *PersonProfileHistory
	err := s.withReadSnapshotContext(ctx, func(tx *loggedTx) error {
		profile, err := s.getPersonProfileTx(ctx, tx, personID, false)
		if err != nil {
			return err
		}
		observations, err := s.listObservationsForPersonTx(ctx, tx, personID)
		if err != nil {
			return err
		}
		mergedIn, err := s.personMergedInParticipantsTx(ctx, tx, personID)
		if err != nil {
			return err
		}
		history = &PersonProfileHistory{
			Person: profile.Person, Names: profile.Names,
			ContactPoints: profile.ContactPoints, Addresses: profile.Addresses,
			Dates: profile.Dates, Categories: profile.Categories,
			Media: profile.Media, Observations: observations, MergedIn: mergedIn,
		}
		return nil
	})
	return history, err
}

func countPersonProfilePatchOperations(patch PersonProfilePatch) int {
	count := 0
	if patch.Names != nil {
		count += len(patch.Names.Add) + len(patch.Names.Supersede)
	}
	if patch.ContactPoints != nil {
		count += len(patch.ContactPoints.Add) + len(patch.ContactPoints.Supersede)
	}
	if patch.Addresses != nil {
		count += len(patch.Addresses.Add) + len(patch.Addresses.Supersede)
	}
	if patch.Dates != nil {
		count += len(patch.Dates.Add) + len(patch.Dates.Supersede)
	}
	if patch.Categories != nil {
		count += len(patch.Categories.Add) + len(patch.Categories.Supersede)
	}
	if patch.Media != nil {
		count += len(patch.Media.Add) + len(patch.Media.Supersede)
	}
	return count
}

func (s *Store) applyPersonProfilePatchTx(
	ctx context.Context,
	tx *loggedTx,
	personID int64,
	patch PersonProfilePatch,
) error {
	if patch.Names != nil {
		for _, id := range patch.Names.Supersede {
			if err := s.supersedePersonNameTx(ctx, tx, personID, id, nil); err != nil {
				return err
			}
		}
		for _, input := range patch.Names.Add {
			if _, err := s.addPersonNameTx(ctx, tx, personID, input); err != nil {
				return err
			}
		}
	}
	if patch.ContactPoints != nil {
		for _, id := range patch.ContactPoints.Supersede {
			if err := s.supersedePersonContactPointTx(ctx, tx, personID, id, nil); err != nil {
				return err
			}
		}
		for _, input := range patch.ContactPoints.Add {
			if _, err := s.addPersonContactPointTx(ctx, tx, personID, input); err != nil {
				return err
			}
		}
	}
	if patch.Addresses != nil {
		for _, id := range patch.Addresses.Supersede {
			if err := s.supersedePersonAddressTx(ctx, tx, personID, id, nil); err != nil {
				return err
			}
		}
		for _, input := range patch.Addresses.Add {
			if _, err := s.addPersonAddressTx(ctx, tx, personID, input); err != nil {
				return err
			}
		}
	}
	if patch.Dates != nil {
		for _, id := range patch.Dates.Supersede {
			if err := s.supersedePersonDateTx(ctx, tx, personID, id, nil); err != nil {
				return err
			}
		}
		for _, input := range patch.Dates.Add {
			if _, err := s.addPersonDateTx(ctx, tx, personID, input); err != nil {
				return err
			}
		}
	}
	if patch.Categories != nil {
		for _, id := range patch.Categories.Supersede {
			if err := s.supersedePersonCategoryTx(ctx, tx, personID, id, nil); err != nil {
				return err
			}
		}
		for _, input := range patch.Categories.Add {
			if _, err := s.addPersonCategoryTx(ctx, tx, personID, input); err != nil {
				return err
			}
		}
	}
	if patch.Media != nil {
		for _, id := range patch.Media.Supersede {
			if err := s.supersedePersonMediaTx(ctx, tx, personID, id, nil); err != nil {
				return err
			}
		}
		for _, input := range patch.Media.Add {
			if _, err := s.addPersonMediaTx(ctx, tx, personID, input); err != nil {
				return err
			}
		}
	}
	return nil
}

func (s *Store) getPersonProfileTx(
	ctx context.Context, tx *loggedTx, personID int64, currentOnly bool,
) (*PersonProfile, error) {
	person, err := s.getPersonTx(ctx, tx, personID)
	if err != nil {
		return nil, err
	}
	profile := &PersonProfile{Person: *person}
	if profile.Names, err = s.listPersonNamesTx(ctx, tx, personID, currentOnly); err != nil {
		return nil, err
	}
	if profile.ContactPoints, err = s.listPersonContactPointsTx(ctx, tx, personID, currentOnly); err != nil {
		return nil, err
	}
	if profile.Addresses, err = s.listPersonAddressesTx(ctx, tx, personID, currentOnly); err != nil {
		return nil, err
	}
	if profile.Dates, err = s.listPersonDatesTx(ctx, tx, personID, currentOnly); err != nil {
		return nil, err
	}
	if profile.Categories, err = s.listPersonCategoriesTx(ctx, tx, personID, currentOnly); err != nil {
		return nil, err
	}
	if profile.Media, err = s.listPersonMediaTx(ctx, tx, personID, currentOnly); err != nil {
		return nil, err
	}
	return profile, nil
}

func (s *Store) personMergedInParticipantsTx(ctx context.Context, tx *loggedTx, personID int64) ([]PersonMergedInParticipant, error) {
	rows, err := tx.QueryContext(ctx, `SELECT m.id, p.participant_id, m.created_at
		FROM person_merges m JOIN person_merge_participants p ON p.merge_id = m.id
		WHERE m.current_person_id = ? AND p.origin_side = 'absorbed' AND p.split_id IS NULL
		AND EXISTS (SELECT 1 FROM person_participants b WHERE b.person_id = ? AND b.participant_id = p.participant_id)
		ORDER BY m.created_at DESC, m.id DESC, p.participant_id`, personID, personID)
	if err != nil {
		return nil, fmt.Errorf("read merged-in participants: %w", err)
	}
	defer func() { _ = rows.Close() }()
	result := []PersonMergedInParticipant{}
	ids := []int64{}
	seen := map[int64]bool{}
	for rows.Next() {
		var item PersonMergedInParticipant
		if err := rows.Scan(&item.MergeID, &item.ParticipantID, &item.MergedAt); err != nil {
			return nil, fmt.Errorf("scan merged-in participant: %w", err)
		}
		if !seen[item.ParticipantID] {
			seen[item.ParticipantID] = true
			item.Identifiers = []ParticipantIdentifierContext{}
			result = append(result, item)
			ids = append(ids, item.ParticipantID)
		}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := rows.Close(); err != nil {
		return nil, err
	}
	identities, err := s.getParticipantIdentityContext(ctx, tx.Tx, ids, false)
	if err != nil {
		return nil, err
	}
	byID := make(map[int64]*PersonMergedInParticipant, len(result))
	for i := range result {
		byID[result[i].ParticipantID] = &result[i]
	}
	for _, member := range identities.Members {
		byID[member.ParticipantID].Member = member
	}
	for _, identifier := range identities.Identifiers {
		item := byID[identifier.ParticipantID]
		item.Identifiers = append(item.Identifiers, identifier)
	}
	return result, nil
}
