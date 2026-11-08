package store

import (
	"context"
	"database/sql"
	"fmt"
)

// ParticipantIdentityContext is the live-store detail omitted from the
// analytical person cache. It is read only and scoped to the requested members.
type ParticipantIdentityContext struct {
	Members     []PersonClusterMember
	Identifiers []ParticipantIdentifierContext
	Links       []ParticipantLinkContext
}

// PersonClusterMember describes a participant in the requested cluster.
type PersonClusterMember struct {
	ParticipantID   int64  `json:"participant_id"`
	DisplayName     string `json:"display_name,omitempty"`
	Email           string `json:"email,omitempty"`
	Phone           string `json:"phone,omitempty"`
	NormalizedValue string `json:"normalized_value,omitempty"`
}

// ParticipantIdentifierContext gives an identifier its stored service and scope.
type ParticipantIdentifierContext struct {
	ParticipantID   int64  `json:"participant_id"`
	Type            string `json:"type"`
	Value           string `json:"value"`
	DisplayValue    string `json:"display_value"`
	NormalizedValue string `json:"normalized_value"`
	ServiceSlug     string `json:"service_slug"`
	ServiceLabel    string `json:"service_label"`
	ScopeKind       string `json:"scope_kind"`
	ScopeValue      string `json:"scope_value"`
}

// ParticipantLinkContext records the origin of a link between cluster members.
type ParticipantLinkContext struct {
	ParticipantA int64
	ParticipantB int64
	OriginKind   string
	Source       string
	Basis        string
}

// GetParticipantIdentityContext returns display and provenance context for a
// participant cluster. loggedDB rebinds each query for PostgreSQL.
func (s *Store) GetParticipantIdentityContext(
	ctx context.Context, participantIDs []int64,
) (*ParticipantIdentityContext, error) {
	return s.getParticipantIdentityContext(ctx, ReadDBContext(ctx, s.db.DB), participantIDs, true)
}

func (s *Store) getParticipantIdentityContext(ctx context.Context, reader SQLReader, participantIDs []int64, links bool) (*ParticipantIdentityContext, error) {
	result := &ParticipantIdentityContext{}
	if len(participantIDs) == 0 {
		return result, nil
	}
	ids := make([]int64, 0, len(participantIDs))
	wanted := make(map[int64]struct{}, len(participantIDs))
	for _, id := range participantIDs {
		if id <= 0 {
			continue
		}
		if _, exists := wanted[id]; exists {
			continue
		}
		wanted[id] = struct{}{}
		ids = append(ids, id)
	}
	const chunkSize = 300 // below SQLite's older 999-placeholder limit
	for start := 0; start < len(ids); start += chunkSize {
		end := min(start+chunkSize, len(ids))
		chunk := ids[start:end]
		args := make([]any, len(chunk))
		for i, id := range chunk {
			args[i] = id
		}
		in := placeholders(len(chunk))
		if err := s.readParticipantIdentityMembers(ctx, reader, &result.Members, in, args); err != nil {
			return nil, err
		}
		if err := s.readParticipantIdentifierContext(ctx, reader, &result.Identifiers, in, args); err != nil {
			return nil, err
		}
		if links {
			if err := s.readParticipantLinkContext(ctx, reader, &result.Links, wanted, in, args); err != nil {
				return nil, err
			}
		}
	}
	return result, nil
}

func (s *Store) readParticipantIdentityMembers(
	ctx context.Context, reader SQLReader, dest *[]PersonClusterMember, in string, args []any,
) error {
	rows, err := reader.QueryContext(ctx, s.Rebind(fmt.Sprintf(`SELECT id,
		COALESCE(display_name, ''), COALESCE(email_address, ''), COALESCE(phone_number, '')
		FROM participants WHERE id IN (%s) ORDER BY id`, in)), args...)
	if err != nil {
		return fmt.Errorf("read participant identity members: %w", err)
	}
	defer func() { _ = rows.Close() }()
	for rows.Next() {
		var member PersonClusterMember
		if err := rows.Scan(&member.ParticipantID, &member.DisplayName, &member.Email, &member.Phone); err != nil {
			return fmt.Errorf("scan participant identity member: %w", err)
		}
		*dest = append(*dest, normalizedClusterMember(member))
	}
	return rows.Err()
}

// normalizedClusterMember sets the canonical email, else phone, that History
// and people detail both show for the member.
func normalizedClusterMember(member PersonClusterMember) PersonClusterMember {
	value, kind := member.Email, ContactAddressEmail
	if value == "" {
		value, kind = member.Phone, ContactAddressPhone
	}
	if value != "" {
		member.NormalizedValue, _ = NormalizeServiceValue(nil, kind, value)
	}
	return member
}

func (s *Store) readParticipantIdentifierContext(
	ctx context.Context, reader SQLReader, dest *[]ParticipantIdentifierContext, in string, args []any,
) error {
	rows, err := reader.QueryContext(ctx, s.Rebind(fmt.Sprintf(`SELECT pi.participant_id,
		pi.identifier_type, pi.identifier_value, COALESCE(pi.display_value, ''), COALESCE(cs.slug, CASE WHEN pi.identifier_type IN ('email', 'phone') THEN pi.identifier_type ELSE '' END),
		COALESCE(cs.display_label, ''), COALESCE(pi.scope_kind, ''),
		COALESCE(pi.scope_value, ''), COALESCE(cs.normalization, '')
		FROM participant_identifiers pi
		LEFT JOIN communication_services cs ON cs.id = pi.service_id
		WHERE pi.participant_id IN (%s)
		ORDER BY pi.participant_id, pi.id`, in)), args...)
	if err != nil {
		return fmt.Errorf("read participant identifier context: %w", err)
	}
	defer func() { _ = rows.Close() }()
	for rows.Next() {
		var identifier ParticipantIdentifierContext
		var strategy string
		if err := rows.Scan(&identifier.ParticipantID, &identifier.Type, &identifier.Value, &identifier.DisplayValue,
			&identifier.ServiceSlug, &identifier.ServiceLabel, &identifier.ScopeKind,
			&identifier.ScopeValue, &strategy); err != nil {
			return fmt.Errorf("scan participant identifier context: %w", err)
		}
		var service *CommunicationService
		if strategy != "" {
			service = &CommunicationService{Normalization: strategy}
		}
		identifier.NormalizedValue, _ = NormalizeServiceValue(service, ContactAddressKind(identifier.Type), identifier.Value)
		*dest = append(*dest, identifier)
	}
	return rows.Err()
}

func (s *Store) readParticipantLinkContext(
	ctx context.Context, reader SQLReader, dest *[]ParticipantLinkContext, wanted map[int64]struct{}, in string, args []any,
) error {
	rows, err := reader.QueryContext(ctx, s.Rebind(fmt.Sprintf(`SELECT pl.participant_a,
		pl.participant_b, pl.identity_match_candidate_id,
		COALESCE(imc.source, ''), COALESCE(imc.basis, '')
		FROM participant_links pl
		LEFT JOIN identity_match_candidates imc ON imc.id = pl.identity_match_candidate_id
		WHERE pl.participant_a IN (%s)
		ORDER BY pl.participant_a, pl.participant_b`, in)), args...)
	if err != nil {
		return fmt.Errorf("read participant link context: %w", err)
	}
	defer func() { _ = rows.Close() }()
	for rows.Next() {
		var link ParticipantLinkContext
		var candidateID sql.NullInt64
		if err := rows.Scan(&link.ParticipantA, &link.ParticipantB, &candidateID,
			&link.Source, &link.Basis); err != nil {
			return fmt.Errorf("scan participant link context: %w", err)
		}
		if _, ok := wanted[link.ParticipantB]; !ok {
			continue
		}
		if candidateID.Valid {
			link.OriginKind = "candidate"
		} else {
			link.OriginKind = "manual"
		}
		*dest = append(*dest, link)
	}
	return rows.Err()
}
