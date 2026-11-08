package store_test

import (
	"os"
	"strconv"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.kenn.io/msgvault/internal/store"
	"go.kenn.io/msgvault/internal/testutil/storetest"
)

func TestGetPersonProfileReturnsEveryValueKindWithOneRevision(t *testing.T) {
	require := require.New(t)
	assert := assert.New(t)
	st := storetest.New(t).Store
	personID := newTestPerson(t, st)
	seedFullProfile(t, st, personID)
	profile, err := st.GetPersonProfileContext(t.Context(), personID)
	require.NoError(err)
	assert.Equal(personID, profile.Person.ID)
	assert.Len(profile.Names, 2)
	assert.Len(profile.ContactPoints, 2)
	assert.Len(profile.Addresses, 1)
	assert.Len(profile.Dates, 1)
	assert.Len(profile.Categories, 1)
	assert.Len(profile.Media, 1)
	assert.Greater(profile.Person.Revision, int64(1), "profile writes bump the person revision")
}

func TestProfileInputsPreserveExplicitZeroOrdinal(t *testing.T) {
	require := require.New(t)
	assert := assert.New(t)
	st := storetest.New(t).Store
	ctx := t.Context()
	personID := newTestPerson(t, st)
	first := store.ValueEnvelopeInput{Source: store.ProvenanceUser}
	explicitZero := store.ValueEnvelopeInput{Source: store.ProvenanceUser, Ordinal: new(0)}

	_, err := st.AddPersonNameContext(ctx, personID, store.PersonNameInput{
		NameKind: store.PersonNameNickname, Formatted: new("First"), Envelope: first,
	})
	require.NoError(err)
	name, err := st.AddPersonNameContext(ctx, personID, store.PersonNameInput{
		NameKind: store.PersonNameNickname, Formatted: new("Pinned first"), Envelope: explicitZero,
	})
	require.NoError(err)
	assert.Equal(0, name.Envelope.Ordinal)

	_, err = st.AddPersonContactPointContext(ctx, personID, store.PersonContactPointInput{
		AddressKind: store.ContactAddressEmail, OriginalValue: "first@example.com", Envelope: first,
	})
	require.NoError(err)
	point, err := st.AddPersonContactPointContext(ctx, personID, store.PersonContactPointInput{
		AddressKind: store.ContactAddressEmail, OriginalValue: "pinned@example.com", Envelope: explicitZero,
	})
	require.NoError(err)
	assert.Equal(0, point.Envelope.Ordinal)

	_, err = st.AddPersonAddressContext(ctx, personID, store.PersonAddressInput{
		AddressKind: store.PersonAddressPostal, StreetAddress: new("First"), Envelope: first,
	})
	require.NoError(err)
	address, err := st.AddPersonAddressContext(ctx, personID, store.PersonAddressInput{
		AddressKind: store.PersonAddressPostal, StreetAddress: new("Pinned"), Envelope: explicitZero,
	})
	require.NoError(err)
	assert.Equal(0, address.Envelope.Ordinal)

	_, err = st.AddPersonDateContext(ctx, personID, store.PersonDateInput{
		DateKind: store.PersonDateCustom, DateText: new("First"), Envelope: first,
	})
	require.NoError(err)
	date, err := st.AddPersonDateContext(ctx, personID, store.PersonDateInput{
		DateKind: store.PersonDateCustom, DateText: new("Pinned"), Envelope: explicitZero,
	})
	require.NoError(err)
	assert.Equal(0, date.Envelope.Ordinal)

	_, err = st.AddPersonCategoryContext(ctx, personID, store.PersonCategoryInput{
		OriginalValue: "First", Envelope: first,
	})
	require.NoError(err)
	category, err := st.AddPersonCategoryContext(ctx, personID, store.PersonCategoryInput{
		OriginalValue: "Pinned", Envelope: explicitZero,
	})
	require.NoError(err)
	assert.Equal(0, category.Envelope.Ordinal)

	_, err = st.AddPersonMediaContext(ctx, personID, store.PersonMediaInput{
		MediaKind: store.PersonMediaPhoto, URI: new("https://example.invalid/first"), Envelope: first,
	})
	require.NoError(err)
	media, err := st.AddPersonMediaContext(ctx, personID, store.PersonMediaInput{
		MediaKind: store.PersonMediaPhoto, URI: new("https://example.invalid/pinned"), Envelope: explicitZero,
	})
	require.NoError(err)
	assert.Equal(0, media.Envelope.Ordinal)

	_, err = st.AddPersonNameContext(ctx, personID, store.PersonNameInput{
		NameKind: store.PersonNameSort, SortAs: new("Invalid"),
		Envelope: store.ValueEnvelopeInput{Source: store.ProvenanceUser, Ordinal: new(-1)},
	})
	assert.ErrorIs(err, store.ErrInvalidProfileOrdinal)
}

func TestApplyPersonProfilePatchIsAtomicUnderRevision(t *testing.T) {
	require := require.New(t)
	assert := assert.New(t)
	st := storetest.New(t).Store
	ctx := t.Context()
	personID := newTestPerson(t, st)
	person, err := st.GetPersonContext(ctx, personID)
	require.NoError(err)
	patched, err := st.ApplyPersonProfilePatchContext(ctx, personID, person.Revision, store.PersonProfilePatch{
		Names: &store.PersonNamePatch{Add: []store.PersonNameInput{{
			NameKind: store.PersonNameFormatted, Formatted: new("Alice Example"),
			Envelope: store.ValueEnvelopeInput{Source: store.ProvenanceUser},
		}}},
		ContactPoints: &store.PersonContactPointPatch{Add: []store.PersonContactPointInput{{
			AddressKind: store.ContactAddressEmail, OriginalValue: "Alice@Example.com",
			Envelope: store.ValueEnvelopeInput{Source: store.ProvenanceUser},
		}}},
	})
	require.NoError(err)
	assert.Equal(person.Revision+1, patched.Person.Revision)
	assert.Len(patched.Names, 1)
	assert.Len(patched.ContactPoints, 1)
	_, err = st.ApplyPersonProfilePatchContext(ctx, personID, person.Revision, store.PersonProfilePatch{
		Names: &store.PersonNamePatch{Add: []store.PersonNameInput{{
			NameKind: store.PersonNameNickname, Formatted: new("Ally"),
			Envelope: store.ValueEnvelopeInput{Source: store.ProvenanceUser},
		}}},
	})
	require.ErrorIs(err, store.ErrPersonRevisionConflict)
}

func TestApplyPersonProfilePatchPublishesIdentityEnrichment(t *testing.T) {
	requirements := require.New(t)
	checks := assert.New(t)
	f := newEnrichmentWorkFixture(t)
	person, err := f.store.GetPersonContext(t.Context(), f.person.ID)
	requirements.NoError(err)
	patched, err := f.store.ApplyPersonProfilePatchContext(
		t.Context(), person.ID, person.Revision, store.PersonProfilePatch{
			Names: &store.PersonNamePatch{Add: []store.PersonNameInput{{
				NameKind: store.PersonNameNickname, Formatted: new("Profile Nickname"),
				Envelope: store.ValueEnvelopeInput{Source: store.ProvenanceUser},
			}}},
		})
	requirements.NoError(err)
	work := f.work(t)
	requirements.Len(work, 1)
	checks.Equal("revision:"+strconv.FormatInt(patched.Person.Revision, 10), work[0].TriggerGeneration)
}

func TestFailedPatchRollsBackEveryCollection(t *testing.T) {
	require := require.New(t)
	assert := assert.New(t)
	st := storetest.New(t).Store
	ctx := t.Context()
	personID := newTestPerson(t, st)
	person, err := st.GetPersonContext(ctx, personID)
	require.NoError(err)
	_, err = st.ApplyPersonProfilePatchContext(ctx, personID, person.Revision, store.PersonProfilePatch{
		Names: &store.PersonNamePatch{Add: []store.PersonNameInput{{
			NameKind: store.PersonNameFormatted, Formatted: new("Alice Example"),
			Envelope: store.ValueEnvelopeInput{Source: store.ProvenanceUser},
		}}},
		ContactPoints: &store.PersonContactPointPatch{Add: []store.PersonContactPointInput{{
			AddressKind: store.ContactAddressUsername, ServiceSlug: new("slack"),
			OriginalValue: "alice", Envelope: store.ValueEnvelopeInput{Source: store.ProvenanceUser},
		}}},
	})
	require.ErrorIs(err, store.ErrServiceScopeRequired)
	profile, err := st.GetPersonProfileContext(ctx, personID)
	require.NoError(err)
	assert.Empty(profile.Names)
	assert.Equal(person.Revision, profile.Person.Revision)
}

func TestPatchSupersedeMovesValuesIntoHistoryOnly(t *testing.T) {
	require := require.New(t)
	assert := assert.New(t)
	st := storetest.New(t).Store
	ctx := t.Context()
	personID := newTestPerson(t, st)
	seedFullProfile(t, st, personID)
	before, err := st.GetPersonProfileContext(ctx, personID)
	require.NoError(err)
	after, err := st.ApplyPersonProfilePatchContext(ctx, personID, before.Person.Revision, store.PersonProfilePatch{
		ContactPoints: &store.PersonContactPointPatch{
			Supersede: []int64{before.ContactPoints[0].Envelope.ID},
		},
	})
	require.NoError(err)
	assert.Len(after.ContactPoints, 1)
	history, err := st.GetPersonProfileHistoryContext(ctx, personID)
	require.NoError(err)
	assert.Len(history.ContactPoints, 2)
}

func TestPatchRejectsEmptyAndOversizedRequests(t *testing.T) {
	require := require.New(t)
	st := storetest.New(t).Store
	ctx := t.Context()
	personID := newTestPerson(t, st)
	person, err := st.GetPersonContext(ctx, personID)
	require.NoError(err)
	_, err = st.ApplyPersonProfilePatchContext(ctx, personID, person.Revision, store.PersonProfilePatch{})
	require.ErrorIs(err, store.ErrPersonProfilePatchEmpty)
	adds := make([]store.PersonCategoryInput, store.MaxPersonProfilePatchOperations+1)
	for i := range adds {
		adds[i] = store.PersonCategoryInput{
			OriginalValue: "tag-" + strconv.Itoa(i),
			Envelope:      store.ValueEnvelopeInput{Source: store.ProvenanceUser},
		}
	}
	_, err = st.ApplyPersonProfilePatchContext(ctx, personID, person.Revision, store.PersonProfilePatch{
		Categories: &store.PersonCategoryPatch{Add: adds},
	})
	require.ErrorIs(err, store.ErrPersonProfilePatchTooLarge)
}

func TestGetPersonProfileHistoryIncludesParticipantObservations(t *testing.T) {
	require := require.New(t)
	assert := assert.New(t)
	st := storetest.New(t).Store
	ctx := t.Context()
	participantID, err := st.EnsureParticipantByIdentifier(
		"email", "alice@example.com", "Alice Example",
	)
	require.NoError(err)
	person, _, err := st.CreatePersonFromParticipantContext(ctx, participantID)
	require.NoError(err)
	_, err = st.RecordContactObservationContext(ctx, participantID, store.ParticipantContactObservationInput{
		AddressKind: store.ContactAddressUsername, ServiceSlug: new("x"),
		OriginalValue: "@alice",
		Envelope:      store.ValueEnvelopeInput{Source: store.ProvenanceArchiveObservation},
	})
	require.NoError(err)
	history, err := st.GetPersonProfileHistoryContext(ctx, person.ID)
	require.NoError(err)
	require.Len(history.Observations, 1)
	assert.Equal("alice", history.Observations[0].NormalizedValue)
	assert.Equal(participantID, history.Observations[0].ParticipantID)

	profile, err := st.GetPersonProfileContext(ctx, person.ID)
	require.NoError(err)
	assert.Empty(profile.ContactPoints,
		"an archive observation is not curated reachability and must not appear as one")
}

func TestGetPersonProfileRejectsUnknownPerson(t *testing.T) {
	st := storetest.New(t).Store

	_, err := st.GetPersonProfileContext(t.Context(), 999999)
	assert.ErrorIs(t, err, store.ErrPersonNotFound)
}

func seedFullProfile(t *testing.T, st *store.Store, personID int64) {
	t.Helper()
	require := require.New(t)
	ctx := t.Context()
	for _, input := range []store.PersonNameInput{
		{NameKind: store.PersonNameFormatted, Formatted: new("Alice Example"),
			Envelope: store.ValueEnvelopeInput{Source: store.ProvenanceUser}},
		{NameKind: store.PersonNameStructured, FamilyName: new("Example"),
			GivenName: new("Alice"), Envelope: store.ValueEnvelopeInput{Source: store.ProvenanceUser}},
	} {
		_, err := st.AddPersonNameContext(ctx, personID, input)
		require.NoError(err)
	}
	for _, input := range []store.PersonContactPointInput{
		{AddressKind: store.ContactAddressEmail, OriginalValue: "alice@example.com",
			Envelope: store.ValueEnvelopeInput{Source: store.ProvenanceUser}},
		{AddressKind: store.ContactAddressPhone, ServiceSlug: new("whatsapp"),
			OriginalValue: "+12025550123", Envelope: store.ValueEnvelopeInput{Source: store.ProvenanceUser}},
	} {
		_, err := st.AddPersonContactPointContext(ctx, personID, input)
		require.NoError(err)
	}
	_, err := st.AddPersonAddressContext(ctx, personID, store.PersonAddressInput{
		AddressKind: store.PersonAddressPostal, StreetAddress: new("123 Example St."),
		Envelope: store.ValueEnvelopeInput{Source: store.ProvenanceUser},
	})
	require.NoError(err)
	_, err = st.AddPersonDateContext(ctx, personID, store.PersonDateInput{
		DateKind: store.PersonDateBirthday, Date: partialDate(0, 4, 12),
		Envelope: store.ValueEnvelopeInput{Source: store.ProvenanceUser},
	})
	require.NoError(err)
	_, err = st.AddPersonCategoryContext(ctx, personID, store.PersonCategoryInput{
		OriginalValue: "Friends", Envelope: store.ValueEnvelopeInput{Source: store.ProvenanceUser},
	})
	require.NoError(err)
	_, err = st.AddPersonMediaContext(ctx, personID, store.PersonMediaInput{
		MediaKind: store.PersonMediaPhoto, MediaType: new("image/png"),
		Data:     []byte("synthetic-photo"),
		Envelope: store.ValueEnvelopeInput{Source: store.ProvenanceUser},
	})
	require.NoError(err)
}

func TestPersonProfileHistoryMergedInSpansPagesAndFollowsBindings(t *testing.T) {
	require := require.New(t)
	assert := assert.New(t)
	st := storetest.New(t).Store
	ctx := t.Context()
	current := mustPromotedPerson(ctx, t, st, "history-owner@example.org", "History owner")
	service, _, err := st.EnsureCommunicationServiceContext(ctx, store.CommunicationServiceInput{Slug: "custom-chat", DisplayLabel: "Custom chat", ScopePolicy: store.ScopePolicyOptional, Normalization: store.NormalizationStripAtLower, NormalizationVersion: 1})
	require.NoError(err)
	var firstParticipant, lastParticipant, firstMerge int64
	for i := range 101 {
		var absorbed *store.Person
		if i == 0 {
			id, err := st.EnsureParticipantByIdentifier("handle", "@Reader", "Reader")
			require.NoError(err)
			require.NoError(st.ClassifyParticipantIdentifierServiceContext(ctx, "handle", "@Reader", &service.ID, new("server"), new("example.org")))
			absorbed, _, err = st.CreatePersonFromParticipant(id)
			require.NoError(err)
			firstParticipant = id
		} else {
			absorbed = mustPromotedPerson(ctx, t, st, "merged-"+strconv.Itoa(i)+"@example.org", "Merged sender")
		}
		lastParticipant = absorbed.ParticipantIDs[0]
		result, err := st.MergePersonsContext(ctx, store.PersonMergeRequest{SurvivorID: current.ID, AbsorbedID: absorbed.ID, ExpectedSurvivorRevision: current.Revision, ExpectedAbsorbedRevision: absorbed.Revision, IdempotencyKey: "profile-merge-" + strconv.Itoa(i), Actor: "test"})
		require.NoError(err)
		current = &result.Person
		if i == 0 {
			firstMerge = result.Merge.ID
		}
	}
	history, err := st.GetPersonProfileHistoryContext(ctx, current.ID)
	require.NoError(err)
	require.Len(history.MergedIn, 101)
	assert.Equal(firstMerge, history.MergedIn[100].MergeID)
	assert.Equal(firstParticipant, history.MergedIn[100].ParticipantID)
	assert.NotEmpty(history.MergedIn[100].Identifiers)

	destination := mustPromotedPerson(ctx, t, st, "history-destination@example.org", "Destination")
	carried, err := st.MergePersonsContext(ctx, store.PersonMergeRequest{SurvivorID: destination.ID, AbsorbedID: current.ID, ExpectedSurvivorRevision: destination.Revision, ExpectedAbsorbedRevision: current.Revision, IdempotencyKey: "profile-carried", Actor: "test"})
	require.NoError(err)
	history, err = st.GetPersonProfileHistoryContext(ctx, destination.ID)
	require.NoError(err)
	require.Len(history.MergedIn, 102)
	for _, item := range history.MergedIn {
		assert.Equal(carried.Merge.ID, item.MergeID)
	}
	_, err = st.SplitPersonMergeContext(ctx, store.PersonSplitRequest{SourcePersonID: destination.ID, MergeID: carried.Merge.ID, ParticipantIDs: []int64{lastParticipant}, ExpectedSourceRevision: carried.Person.Revision, IdempotencyKey: "profile-split", Actor: "test"})
	require.NoError(err)
	history, err = st.GetPersonProfileHistoryContext(ctx, destination.ID)
	require.NoError(err)
	require.Len(history.MergedIn, 101)
	for _, item := range history.MergedIn {
		assert.NotEqual(lastParticipant, item.ParticipantID)
	}
}

func TestPersonProfileHistoryOnlyAttributesRecordedMergeMembers(t *testing.T) {
	for _, chained := range []bool{false, true} {
		t.Run(strconv.FormatBool(chained), func(t *testing.T) {
			require := require.New(t)
			assert := assert.New(t)
			st := storetest.New(t).Store
			ctx := t.Context()
			survivor := mustPromotedPerson(ctx, t, st, "owner@example.org", "Owner")
			absorbed := mustPromotedPerson(ctx, t, st, "original@example.org", "Original")
			merged, err := st.MergePersonsContext(ctx, store.PersonMergeRequest{SurvivorID: survivor.ID, AbsorbedID: absorbed.ID, ExpectedSurvivorRevision: survivor.Revision, ExpectedAbsorbedRevision: absorbed.Revision, IdempotencyKey: "recorded-first", Actor: "test"})
			require.NoError(err)
			later, err := st.EnsureParticipant("later@example.org", "Later", "example.org")
			require.NoError(err)
			_, err = st.LinkParticipants(absorbed.ParticipantIDs[0], later)
			require.NoError(err)
			personID, mergeID := survivor.ID, merged.Merge.ID
			want := map[int64]int64{absorbed.ParticipantIDs[0]: mergeID}
			if chained {
				current, err := st.GetPersonContext(ctx, survivor.ID)
				require.NoError(err)
				destination := mustPromotedPerson(ctx, t, st, "destination@example.org", "Destination")
				carried, err := st.MergePersonsContext(ctx, store.PersonMergeRequest{SurvivorID: destination.ID, AbsorbedID: current.ID, ExpectedSurvivorRevision: destination.Revision, ExpectedAbsorbedRevision: current.Revision, IdempotencyKey: "recorded-carried", Actor: "test"})
				require.NoError(err)
				personID, mergeID = destination.ID, carried.Merge.ID
				// The second merge really captured the first late link, so it now has merge provenance.
				want = map[int64]int64{survivor.ParticipantIDs[0]: mergeID, absorbed.ParticipantIDs[0]: mergeID, later: mergeID}
				later, err = st.EnsureParticipant("after-chain@example.org", "After chain", "example.org")
				require.NoError(err)
				_, err = st.LinkParticipants(absorbed.ParticipantIDs[0], later)
				require.NoError(err)
			}
			history, err := st.GetPersonProfileHistoryContext(ctx, personID)
			require.NoError(err)
			got := map[int64]int64{}
			for _, item := range history.MergedIn {
				got[item.ParticipantID] = item.MergeID
			}
			assert.Equal(want, got, "a later identity link was not brought in by the earlier merge")
			// The detail-label case covers later survivor links; this verifies absorbed links remain splittable.
			detail, err := st.GetPersonMergeContext(ctx, mergeID)
			require.NoError(err)
			assert.Contains(detail.Participants, store.PersonMergeParticipant{MergeID: mergeID, ParticipantID: later, OriginSide: "absorbed"})
			// The authorizer failure is SQLite-only; keep the provenance checks above on both backends.
			if !chained && strings.HasPrefix(os.Getenv("MSGVAULT_TEST_DB"), "postgres") {
				return
			}
			failure := "identifiers"
			if chained {
				failure = "snapshot"
			}
			injectPersonMergeReadFailure(t, st, mergeID, failure)
			_, err = st.GetPersonProfileHistoryContext(ctx, personID)
			if chained {
				require.ErrorIs(err, store.ErrPersonMergeSnapshotCorrupt)
			} else {
				require.Error(err)
			}
		})
	}
}
