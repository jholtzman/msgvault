import { mergeResult } from '../../directory/entity-fixtures.test-support';
import { emptyProfile } from '../../directory/profile-fixtures.test-support';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';

import { createAPIClient } from '../../api/client';
import ProfileHistoryDialog from './ProfileHistoryDialog.svelte';
import { DirectoryProfileController } from '../../directory/profile-controller.svelte';
import type { AttributeDefinition } from '../../api/generated/models';

const when = '2026-08-01T00:00:00Z';
const currentEnvelope = { ordinal: 0, source: 'user', active_from: when, created_at: when, updated_at: when, vcard: {} };

function person() {
  return { id: 7, revision: 3, display_name: 'Test User', participant_ids: [], vcard_uid: 'person-7', created_at: when, updated_at: when };
}

describe('ProfileHistoryDialog', () => {
  it.each(['attributes', 'definitions'])('reloads custom history on open and retries failed %s without hiding profile history', async (failedSection) => {
    let failing = true;
    let note = 'Earlier note';
    const requests: URL[] = [];
    const definition: AttributeDefinition = {
      id: 8, universal_id: '00000000-0000-4000-8000-000000000008', object_type: 'person', slug: 'note', label: 'Note',
      value_type: 'text', field_type: 'textarea', cardinality: 'single', display_order: 0, is_required: false,
      ownership: 'user', ui_creatable: true, ui_editable: true, api_mutable: true, is_searchable: false,
      is_sensitive: false, is_audited: true, is_deletable: true, history_exempt: false, is_active: true,
      revision: 1, created_at: when, updated_at: when,
    };
    const client = createAPIClient(vi.fn<typeof fetch>(async (input) => {
      const url = new URL((input instanceof Request ? input : new Request(input)).url);
      requests.push(url);
      if (url.pathname.endsWith('/merges')) return Response.json({ merges: [] });
      if (url.pathname === '/api/v1/people/7') return Response.json(person(), { headers: { ETag: '"person-7-r3"' } });
      if (url.pathname.endsWith('/profile')) return Response.json(emptyProfile(person()), { headers: { ETag: '"profile-7-r3"' } });
      if (url.pathname.endsWith('/contact-state')) return Response.json({ person_id: 7, interaction_count: 0, cadence_status: 'unknown', computed_at: when, stale: false });
      if (url.pathname.endsWith('/profile/history')) return Response.json({ ...emptyProfile(person()), observations: [], names: [{
        person_id: 7, name_kind: 'formatted', original_value: 'Current Name', is_derived: false, envelope: { ...currentEnvelope, id: 2 },
      }] });
      if (url.pathname.endsWith('/attributes')) {
        if (failing && failedSection === 'attributes') return Response.json({ message: 'attributes unavailable' }, { status: 503 });
        return Response.json({ person_id: 7, attributes: [{ definition, current: [{ id: 10, person_id: 7, definition_id: 8, definition_slug: 'note', ordinal: 0, value: { type: 'text', text: 'Imported note' }, source: 'carddav_import', source_ref: 'source-card-7', actor: 'synthetic-importer', confidence: 0.8, active_from: when, created_at: when }], history: [{
          id: 9, person_id: 7, definition_id: 8, definition_slug: 'note', ordinal: 0, value: { type: 'text', text: note },
          source: 'user', active_from: when, active_until: '2026-08-02T00:00:00Z', created_at: when,
        }] }] });
      }
      if (url.pathname.endsWith('/attribute-definitions')) {
        if (failing && failedSection === 'definitions') return Response.json({ message: 'definitions unavailable' }, { status: 503 });
        return Response.json({ definitions: [definition] });
      }
      throw new Error(`unexpected ${url.pathname}`);
    }));
    const controller = new DirectoryProfileController(client, 7, { person: person(), etags: {}, errors: { attributes: 'initial request failed' } });
    const props = { client, controller, personID: 7, onClose: vi.fn() };
    const dialog = render(ProfileHistoryDialog, props);
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain("Couldn't load field history."));
    expect(await screen.findByText('Current Name')).toBeDefined();
    failing = false;
    await fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Earlier note')).toBeDefined();
    expect(screen.queryByRole('alert')).toBeNull();
    await dialog.unmount();
    note = 'Latest note';
    render(ProfileHistoryDialog, props);
    expect(await screen.findByText('Latest note')).toBeDefined();
    expect(screen.queryByText('Earlier note')).toBeNull();
    expect(requests.filter(url => url.pathname.endsWith('/attributes')).every(url => url.searchParams.get('history') === 'true')).toBe(true);
  });

  it('preserves structured provenance and classifies every closed value as earlier', async () => {
    const requests: Request[] = [];
    const client = createAPIClient(vi.fn<typeof fetch>(async (input) => {
      const request = input instanceof Request ? input : new Request(input);
      requests.push(request);
      if (new URL(request.url).pathname.endsWith('/merges')) return Response.json({ merges: [] });
      return Response.json({
        person: person(),
        names: [
          { person_id: 7, name_kind: 'formatted', original_value: 'Current Name', is_derived: false, envelope: { id: 2, ordinal: 0, source: 'user', active_from: when, created_at: when, updated_at: when, vcard: {} } },
          { person_id: 7, name_kind: 'formatted', original_value: 'Previous Name', is_derived: false, envelope: { id: 1, ordinal: 0, source: 'carddav_import', source_ref: 'synthetic-card', active_from: when, active_until: '2026-08-02T00:00:00Z', created_at: when, updated_at: when, superseded_at: '2026-08-02T00:00:00Z', vcard: {} } }
        ],
        contact_points: [...['workspace-a', 'workspace-b'].map((scope, index) => ({
          person_id: 7, address_kind: 'username', original_value: 'alice', normalized_value: 'alice', normalization: 'casefold', normalization_version: 1,
          service_slug: 'slack', scope_kind: 'workspace', scope_value: scope,
          envelope: { id: 20 + index, ordinal: index, source: 'user', created_at: when, updated_at: when, superseded_at: '2026-08-02T00:00:00Z', vcard: {} }
        })), { person_id: 7, address_kind: 'email', original_value: 'current@example.com', normalized_value: 'current@example.com', normalization: 'email', normalization_version: 1, envelope: { ...currentEnvelope, id: 30 } }],
        addresses: [{ person_id: 7, address_kind: 'postal', original_value: 'Current address', envelope: { ...currentEnvelope, id: 31 } }],
        dates: [{ person_id: 7, date_kind: 'birthday', date: { month: 2, day: 14 }, date_text: 'February 14', original_value: '--02-14', envelope: { ...currentEnvelope, id: 32 } }],
        categories: [{ person_id: 7, normalized_value: 'scheduled end category', original_value: 'Scheduled end category', envelope: { ...currentEnvelope, id: 33, active_until: '2999-01-01T00:00:00Z' } }, {
          person_id: 7, original_value: 'Past category', normalized_value: 'past category',
          envelope: { id: 8, ordinal: 0, source: 'user', active_until: '2026-07-31T00:00:00Z', created_at: when, updated_at: when, vcard: {} }
        }],
        media: [{ person_id: 7, media_kind: 'photo', has_data: false, original_value: 'Current photo', envelope: { ...currentEnvelope, id: 34 } }],
        observations: [{
          participant_id: 70, address_kind: 'email', original_value: 'observed@example.test',
          normalized_value: 'observed@example.test', normalization: 'email', normalization_version: 1,
          service_slug: 'email', source_id: 12, observed_at: '2026-07-31T12:00:00Z',
          envelope: { id: 9, ordinal: 0, source: 'archive_observation', created_at: when, updated_at: when, vcard: {} }
        }]
      });
    }));

    render(ProfileHistoryDialog, { client, personID: 7, onClose: vi.fn() });

    expect((await screen.findByText('Previous Name')).closest('.detail-row')?.textContent).toContain('From CardDAV contacts');
    for (const title of ['Names', 'Email and phone', 'Addresses', 'Dates', 'Categories', 'Media', 'Seen in services']) {
      expect(screen.getByRole('heading', { name: title })).toBeDefined();
    }
    expect.soft(screen.getByText('Scheduled end category').closest('details')).not.toBeNull();
    const dateText = '(Jul|Aug) \\d{1,2}';
    for (const value of ['Current Name', 'current@example.com', 'Current address', 'Birthday: February 14', 'Current photo']) {
      const row = screen.getByText(value).closest('.detail-row')!;
      expect(row.closest('details')).toBeNull();
      // One provenance line under the value; every timestamp sits in its tooltip.
      const line = row.querySelector<HTMLElement>('.description')!;
      expect(line.textContent).toMatch(new RegExp(`^You · ${dateText}$`));
      expect(line.title).toMatch(/^Updated /);
      expect(row.textContent).not.toMatch(/Valid from|Created|Updated|\d{4}-\d{2}-\d{2}T/);
    }
    const summaries = screen.getAllByText(/earlier values?$/).map((node) => node.textContent);
    expect(summaries).toEqual(['1 earlier value', '2 earlier values', '2 earlier values']);
    for (const value of ['Previous Name', 'Past category']) {
      const row = screen.getByText(value).closest('.detail-row')!;
      expect(row.closest('details')).not.toBeNull();
      expect(row.querySelector<HTMLElement>('.description')!.title).toMatch(/Valid until|Replaced/);
    }
    expect(screen.getByText(/^Slack · workspace-a · You · /)).toBeDefined();
    expect(screen.getByText(/^Slack · workspace-b · You · /)).toBeDefined();
    expect(document.body.textContent).not.toMatch(/Service:|Scope:|Observed:/);
    expect(requests.map((request) => new URL(request.url).pathname)).toContain('/api/v1/people/7/profile/history');
  });

  it('shows readable observation provenance without the numeric source ID', async () => {
    const client = createAPIClient(async input => {
      const request = input instanceof Request ? input : new Request(input);
      if (new URL(request.url).pathname.endsWith('/merges')) return Response.json({ merges: [] });
      return Response.json({ ...emptyProfile(person()), observations: [{
        participant_id: 70, address_kind: 'email', original_value: 'observed@example.test',
        normalized_value: 'observed@example.test', normalization: 'email', normalization_version: 1,
        service_slug: 'email', source_id: 987654321, observed_at: '2026-07-31T12:00:00Z',
        envelope: { ...currentEnvelope, id: 9, source: 'archive_observation', source_ref: 'synthetic-archive' },
      }] });
    });
    render(ProfileHistoryDialog, { client, personID: 7, onClose: vi.fn() });

    const row = (await screen.findByText('observed@example.test')).closest('.detail-row')!;
    const line = row.querySelector<HTMLElement>('.description')!;
    expect(line.textContent).toMatch(/^Email · From your messages · /);
    expect(line.title).toMatch(/Seen Jul 31, 2026/);
    expect(row.textContent).not.toMatch(/987654321|synthetic-archive/);
  });

  it.each([false, true])('lists each merged-in address once, including formatted phone=%s', async formattedPhone => {
    const merge = { id: 41, survivor_person_id: 7, absorbed_person_id: 9, current_person_id: 7, survivor_vcard_uid: 'person-7', absorbed_vcard_uid: 'person-9', survivor_revision_before: 2, absorbed_revision_before: 1, survivor_revision_after: 3, actor: 'web', snapshot_version: 1, snapshot_sha256: 'synthetic-digest', created_at: when };
    const client = createAPIClient(async input => {
      const path = new URL((input instanceof Request ? input : new Request(input)).url).pathname;
    const labels = {
        profiles: [{ id: 7, display_name: 'Current person', participant_ids: [2] }, { id: 9, display_name: 'Earlier person', participant_ids: [1, 3] }],
        participants: [{ merge_id: 41, participant_id: 1, origin_side: 'absorbed' }, { merge_id: 41, participant_id: 3, origin_side: 'absorbed', split_id: 5 }],
        members: [], identifiers: [{ participant_id: 1, type: formattedPhone ? 'phone' : 'email', value: formattedPhone ? '+15550100100' : 'work@example.org', normalized_value: formattedPhone ? '+15550100100' : 'work@example.org', service_slug: formattedPhone ? 'phone' : 'email', ...(formattedPhone ? { display_value: '+1 555 010 0100' } : {}) }], incomplete: false,
      };
      if (path.endsWith('/merges')) return Response.json({ merges: [{ merge, labels, participant_count: 3, row_count: 0, pending_candidate_count: 0, split_count: 0, row_action_counts: {} }], limit: 100, offset: 0 });
      // One address stays from the merge; one was split back since, so it isn't listed.
      if (path === '/api/v1/person-merges/41') return Response.json({ merge, labels, participants: [
        { merge_id: 41, participant_id: 1, origin_side: 'absorbed' }, { merge_id: 41, participant_id: 3, origin_side: 'absorbed', split_id: 5 }, { merge_id: 41, participant_id: 2, origin_side: 'survivor' },
      ], rows: [], splits: [], review_candidates: [] });
      if (path.startsWith('/api/v1/participants/')) {
        const id = Number(path.split('/').at(-1));
        return Response.json({ identifiers: [{ participant_id: id, type: formattedPhone ? 'phone' : 'email', value: id === 1 ? formattedPhone ? '+15550100100' : 'work@example.org' : `other${id}@example.org`, ...(formattedPhone && id === 1 ? { display_value: '+1 555 010 0100' } : {}) }] });
      }
      if (/^\/api\/v1\/people\/\d+$/.test(path)) return Response.json({ ...person(), id: Number(path.split('/').at(-1)) });
      return Response.json({ ...emptyProfile(person()), observations: [], contact_points: [{
        person_id: 7, address_kind: formattedPhone ? 'phone' : 'email', original_value: formattedPhone ? '+1 555 010 0100' : 'home@example.org', normalized_value: formattedPhone ? '+15550100100' : 'home@example.org', normalization: 'email', normalization_version: 1, envelope: { ...currentEnvelope, id: 3 },
      }] });
    });
    render(ProfileHistoryDialog, { client, personID: 7, onClose: vi.fn() });

    const section = (await screen.findByRole('heading', { name: 'Email and phone' })).closest('section')!;
    if (formattedPhone) {
      await screen.findByRole('button', { name: /^Open .+ merged into .+ · / });
      expect(section.querySelectorAll('.detail-row')).toHaveLength(1);
      expect(section.textContent).toContain('+1 555 010 0100');
      return;
    }
    await waitFor(() => expect(section.textContent).toContain('work@example.org'));
    expect(section.textContent).toContain('home@example.org');
    expect(section.textContent).not.toContain('other3@example.org');
    // The row opens the merge that brought the address in; its line says when, with the time in its tooltip.
    const row = screen.getByRole('button', { name: 'Open the merge that brought in work@example.org' }).closest('.detail-row')!;
    const line = row.querySelector<HTMLElement>('.description')!;
    expect(line.textContent).toMatch(/^Merged in · (Jul|Aug) \d{1,2}$/);
    expect(line.getAttribute('title')).toMatch(/^Merged /);
    expect(row.querySelector('button')?.title).toMatch(/^Merged /);
    await fireEvent.click(screen.getByRole('button', { name: 'Open the merge that brought in work@example.org' }));
    expect(await screen.findByRole('group', { name: 'Merged profiles' })).toBeDefined();
  });

  it('dedupes the same service address while keeping the same handle in another workspace', async () => {
    const merge = mergeResult(person()).merge;
    render(ProfileHistoryDialog, { personID: 7, onClose: vi.fn(), client: createAPIClient(async input => {
      const path = new URL((input as Request).url).pathname;
    const labels = {
      profiles: [{ id: 7, display_name: 'Test User', participant_ids: [] }, { id: 9, participant_ids: [1, 2] }],
      participants: [1, 2].map(participant_id => ({ merge_id: 41, participant_id, origin_side: 'absorbed' })), members: [],
      identifiers: [1, 2].map(participant_id => ({ participant_id, type: 'handle', service_slug: 'slack', service_label: 'Slack', value: 'neri', normalized_value: 'neri', scope_kind: 'workspace', scope_value: participant_id === 1 ? 'garden-club' : 'seed-exchange' })), incomplete: false,
    };
      if (path.endsWith('/merges')) return Response.json({ merges: [{ merge, labels, participant_count: 2, row_count: 0, pending_candidate_count: 0, split_count: 0, row_action_counts: {} }], limit: 100, offset: 0 });
      if (path.endsWith('/snapshot')) return Response.json({ snapshot: { persons: [{ id: 7, display_name: 'Test User' }, { id: 9, participant_ids: [1, 2] }] } });
      if (path === '/api/v1/person-merges/41') return Response.json({ merge, labels, participants: [1, 2].map(participant_id => ({ merge_id: 41, participant_id, origin_side: 'absorbed' })), rows: [], splits: [], review_candidates: [] });
      if (path.includes('/participants/')) {
        const id = Number(path.split('/').at(-1));
        return Response.json({ identifiers: [{ participant_id: id, type: 'handle', service_slug: 'slack', service_label: 'Slack', value: 'neri', normalized_value: 'neri', scope_kind: 'workspace', scope_value: id === 1 ? 'garden-club' : 'seed-exchange' }] });
      }
      return Response.json({ ...emptyProfile(person()), observations: [{ participant_id: 1, address_kind: 'username', original_value: 'neri', normalized_value: 'neri', normalization: 'text', normalization_version: 1, service_slug: 'slack', scope_kind: 'workspace', scope_value: 'garden-club', envelope: { ...currentEnvelope, id: 3 } }] });
    }) });
    await screen.findByRole('button', { name: /^Open Slack · neri · workspace: garden-club merged into Test User · / });
    const section = screen.getByRole('heading', { name: 'Email and phone' }).closest('section')!;
    expect(section.querySelectorAll('.detail-row')).toHaveLength(1);
    expect(section.textContent).toContain('Slack · neri · workspace: seed-exchange');
  });

  it.each([false, true])('loads history before offering splits and refreshes after reconciliation (initial read fails=%s)', async initialFailure => {
    let reconciled = false;
    let historyReads = 0;
    let initialResponse: Response | undefined;
    let releaseInitial!: (response: Response) => void;
    const pendingInitial = new Promise<Response>(resolve => { releaseInitial = resolve; });
    const source = { ...person(), participant_ids: [1, 2] };
    const remaining = { ...source, revision: 4, participant_ids: [2] };
    const restored = { ...source, id: 9, revision: 1, display_name: 'Restored Person', participant_ids: [1], vcard_uid: 'person-9' };
    const merge = { id: 41, survivor_person_id: 7, absorbed_person_id: 9, current_person_id: 7, survivor_vcard_uid: 'person-7', absorbed_vcard_uid: 'person-9', survivor_revision_before: 2, absorbed_revision_before: 1, survivor_revision_after: 3, actor: 'web', snapshot_version: 1, snapshot_sha256: 'synthetic-digest', created_at: when };
    const client = createAPIClient(async input => {
      const request = input instanceof Request ? input : new Request(input);
      const path = new URL(request.url).pathname;
    const labels = {
        profiles: [{ id: 9, display_name: 'Restored Person', participant_ids: [1] }, { id: 7, display_name: 'Retained name', participant_ids: [] }],
        participants: [{ merge_id: 41, participant_id: 1, origin_side: 'absorbed' }], members: [],
        identifiers: [{ participant_id: 1, type: 'email', value: 'observed@example.com', normalized_value: 'observed@example.com', service_slug: 'email' }], incomplete: false,
      };
      if (path.endsWith('/profile/history')) {
        historyReads += 1;
        if (initialFailure && historyReads === 1) return Response.json({ error: 'unavailable', message: 'history unavailable' }, { status: 503 });
        const response = Response.json({
          person: reconciled ? remaining : source,
          names: [{ person_id: 7, name_kind: 'formatted', formatted: 'Retained name', original_value: 'Retained name', is_derived: false, envelope: { ...currentEnvelope, id: 1 } }, ...(reconciled ? [] : [{ person_id: 7, name_kind: 'nickname', formatted: 'Moved alias', original_value: 'Moved alias', is_derived: false, envelope: { ...currentEnvelope, id: 2 } }])],
          contact_points: reconciled ? [] : [{ person_id: 7, address_kind: 'email', original_value: 'moved@example.com', normalized_value: 'moved@example.com', normalization: 'email', normalization_version: 1, envelope: { ...currentEnvelope, id: 3 } }],
          observations: reconciled ? [] : [{ participant_id: 1, address_kind: 'email', original_value: 'observed@example.com', normalized_value: 'observed@example.com', service_slug: 'email', normalization: 'email', normalization_version: 1, observed_at: when, envelope: { ...currentEnvelope, id: 4, source: 'archive_observation' } }],
          addresses: [], dates: [], categories: [], media: [],
        });
        if (historyReads === (initialFailure ? 2 : 1)) {
          initialResponse = response;
          return pendingInitial;
        }
        return response;
      }
      if (path.endsWith('/merges')) return Response.json({ merges: [{ merge, labels, participant_count: 1, row_count: 0, pending_candidate_count: 0, split_count: 0, row_action_counts: {} }], limit: 100, offset: 0 });
      if (path === '/api/v1/participants/1') return Response.json({ identifiers: [{ participant_id: 1, type: 'email', value: 'observed@example.com', normalized_value: 'observed@example.com', service_slug: 'email' }] });
      if (path === '/api/v1/person-merges/41/snapshot') return Response.json({ snapshot: { persons: [{ id: 9, display_name: 'Restored Person', participant_ids: [1] }, { id: 7, display_name: 'Retained name' }] } });
      if (path === '/api/v1/person-merges/41') return Response.json({ merge, labels, participants: [{ merge_id: 41, participant_id: 1, origin_side: 'absorbed' }], rows: [], splits: [], review_candidates: [] });
      if (path === '/api/v1/people/7') return Response.json(source, { headers: { ETag: '"person-7-r3"' } });
      if (path === '/api/v1/people/7/split') return Response.json({ source_person: remaining, new_person: restored, split: { id: 55, merge_id: 41, source_person_id: 7, new_person_id: 9, new_person_uid: 'person-9', source_revision_before: 3, source_revision_after: 4, exact_reversal: true, actor: 'web', created_at: when }, exact_reversal: true, ambiguous_rows: [], unrestored_rows: [], uid_alias_disposition: 'restored', identity_revision: 2, cache_state: 'ready' }, { headers: { ETag: '"person-7-r4"', 'X-New-Person-ETag': '"person-9-r1"' } });
      throw new Error(`unexpected ${request.method} ${path}`);
    });
    const onSplitCommitted = vi.fn(async () => { reconciled = true; });
    const view = render(ProfileHistoryDialog, { client, personID: 7, onClose: vi.fn(), onSplitCommitted });
    try {
      if (initialFailure) {
        expect((await screen.findByRole('alert')).textContent).toContain("Couldn't load names, email, phone, and other details.");
        await screen.findByRole('button', { name: /^Open .+ merged into .+ · / });
        await fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
      }
      await act(async () => { await vi.waitFor(() => expect(initialResponse).toBeDefined()); });
      expect(await screen.findByRole('button', { name: /^Open .+ merged into .+ · / })).toBeDefined();
      expect(screen.getByText('Loading profile history…')).toBeDefined();
      await act(async () => { releaseInitial(initialResponse!); });
      for (const value of ['Moved alias', 'moved@example.com', 'observed@example.com']) expect(await screen.findByText(value)).toBeDefined();
      await fireEvent.click(await screen.findByRole('button', { name: /^Open .+ merged into .+ · / }));
      await fireEvent.click(await screen.findByRole('button', { name: 'Split…' }));
      await fireEvent.click(await screen.findByRole('checkbox', { name: 'observed@example.com' }));
      await fireEvent.click(screen.getByRole('button', { name: 'Split into new person' }));
      await waitFor(() => {
        expect(onSplitCommitted).toHaveBeenCalledWith({ sourcePersonID: 7, newPersonID: 9 });
        expect(screen.getByRole('dialog', { name: 'Split complete' })).toBeDefined();
        expect(historyReads).toBe(initialFailure ? 3 : 2);
      });
    } finally { releaseInitial(initialResponse ?? Response.json({})); view.unmount(); }
  });


});

it.each(['matrix', 'inline', 'custom-chat'])('keeps differently cased %s identities as separate merge addresses', async service => {
  const merge = mergeResult(person()).merge;
  render(ProfileHistoryDialog, { personID: 7, onClose: vi.fn(), client: createAPIClient(async input => {
    const path = new URL((input as Request).url).pathname;
    const labels = {
      profiles: [{ id: 7, display_name: 'Test User', participant_ids: [] }, { id: 9, participant_ids: [1, 2] }],
      participants: [1, 2].map(participant_id => ({ merge_id: 41, participant_id, origin_side: 'absorbed' })), members: [],
      identifiers: [1, 2].map(participant_id => ({ participant_id, type: service, service_slug: service, service_label: service, value: participant_id === 1 ? 'reader' : 'Reader', normalized_value: participant_id === 1 ? 'reader' : 'Reader', scope_kind: 'server', scope_value: 'example.org' })), incomplete: false,
    };
    if (path.endsWith('/merges')) return Response.json({ merges: [{ merge, labels, participant_count: 2, row_count: 0, pending_candidate_count: 0, split_count: 0, row_action_counts: {} }], limit: 100, offset: 0 });
    if (path.endsWith('/snapshot')) return Response.json({ snapshot: { persons: [{ id: 7, display_name: 'Test User' }, { id: 9, participant_ids: [1, 2] }] } });
    if (path === '/api/v1/person-merges/41') return Response.json({ merge, labels, participants: [1, 2].map(participant_id => ({ merge_id: 41, participant_id, origin_side: 'absorbed' })), rows: [], splits: [], review_candidates: [] });
    if (path.includes('/participants/')) {
      const id = Number(path.split('/').at(-1));
      return Response.json({ identifiers: [{ participant_id: id, type: service, service_slug: service, service_label: service, value: id === 1 ? 'reader' : 'Reader', scope_kind: 'server', scope_value: 'example.org' }] });
    }
    return Response.json({ ...emptyProfile(person()), observations: [{ participant_id: 1, address_kind: 'username', original_value: 'reader', normalized_value: 'reader', normalization: 'none', normalization_version: 1, service_slug: service, scope_kind: 'server', scope_value: 'example.org', envelope: { ...currentEnvelope, id: 3 } }] });
  }) });
  expect(await screen.findByRole('button', { name: `Open the merge that brought in ${service} · Reader · server: example.org` })).toBeDefined();
});

it('lists an imported address once when successive merges carry it forward', async () => {
  const first = { ...mergeResult(person()).merge, id: 41, absorbed_person_id: 9, survivor_person_id: 8, current_person_id: 7 };
  const second = { ...first, id: 42, absorbed_person_id: 8, survivor_person_id: 7 };
  render(ProfileHistoryDialog, { personID: 7, onClose: vi.fn(), client: createAPIClient(async input => {
    const path = new URL((input as Request).url).pathname;
    const labels = (id: number) => ({ profiles: [{ id: 7, display_name: 'Current person', participant_ids: [] }, { id: 8, display_name: 'Earlier person', participant_ids: [1] }, { id: 9, display_name: 'First person', participant_ids: [1] }], participants: [{ merge_id: id, participant_id: 1, origin_side: 'absorbed' }], members: [{ participant_id: 1, email: 'carried@example.org', normalized_value: 'carried@example.org' }], identifiers: [], incomplete: false });
    if (path.endsWith('/merges')) return Response.json({ merges: [second, first].map(merge => ({ merge, labels: labels(merge.id), participant_count: 1, row_count: 0, pending_candidate_count: 0, split_count: 0, row_action_counts: {} })), limit: 100, offset: 0 });
    if (path.endsWith('/snapshot')) return Response.json({ version: 1, snapshot: { version: 1, persons: [{ id: 7, display_name: 'Current person' }, { id: 8, display_name: 'Earlier person', participant_ids: [1] }, { id: 9, display_name: 'First person', participant_ids: [1] }] } });
    if (path.startsWith('/api/v1/person-merges/')) return Response.json({ labels: labels(Number(path.split('/').at(-1))), merge: path.endsWith('/41') ? first : second, participants: [{ merge_id: Number(path.split('/').at(-1)), participant_id: 1, origin_side: 'absorbed' }], rows: [], splits: [], review_candidates: [] });
    if (path.includes('/participants/')) return Response.json({ participant: { participant_id: 1, display_name: 'Named sender', email: 'carried@example.org', normalized_value: 'carried@example.org' }, identifiers: [] });
    return Response.json(emptyProfile(person()));
  }) });
  await waitFor(() => expect(screen.queryByText('Loading merges…')).toBeNull());
  await screen.findByRole('button', { name: /^Open First person merged into Earlier person/ });
  const addresses = screen.getAllByRole('button', { name: 'Open the merge that brought in carried@example.org' });
  expect(addresses).toHaveLength(1);
  await fireEvent.click(addresses[0]);
  expect(await screen.findByRole('dialog', { name: 'Earlier person merged into Current person' })).toBeDefined();
});


it('keeps a curated mixed-case email once when its merged-in address has the same server identity', async () => {
  const merge = mergeResult(person()).merge;
  render(ProfileHistoryDialog, { personID: 7, onClose: vi.fn(), client: createAPIClient(async input => {
    const path = new URL((input as Request).url).pathname;
    if (path.endsWith('/merges')) return Response.json({ merges: [{ merge, labels: {
      profiles: [{ id: 7, display_name: 'Test User', participant_ids: [] }, { id: 9, display_name: 'Earlier person', participant_ids: [1] }],
      participants: [{ merge_id: 41, participant_id: 1, origin_side: 'absorbed' }], members: [{ participant_id: 1, email: 'mira@example.org', normalized_value: 'mira@example.org' }], identifiers: [], incomplete: false,
    }, participant_count: 1, row_count: 0, split_count: 0, pending_candidate_count: 0, row_action_counts: {} }], limit: 100, offset: 0 });
    return Response.json({ ...emptyProfile(person()), contact_points: [{ person_id: 7, address_kind: 'email', original_value: 'Mira@Example.org', normalized_value: 'mira@example.org', service_slug: 'email', normalization: 'email', normalization_version: 1, envelope: { ...currentEnvelope, id: 3 } }] });
  }) });
  await screen.findByRole('button', { name: /^Open Earlier person merged into Test User/ });
  expect(screen.getByText('Mira@Example.org')).toBeDefined();
  expect(screen.queryByRole('button', { name: 'Open the merge that brought in mira@example.org' })).toBeNull();
});
