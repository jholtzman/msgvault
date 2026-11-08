import { mergeResult, person } from '../../directory/entity-fixtures.test-support';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createAPIClient } from '../../api/client';
import type { PersonMergeDetail as GeneratedPersonMergeDetail } from '../../api/generated/models';
import PersonMergeHistory from './PersonMergeHistory.svelte';

type MergeDetail = GeneratedPersonMergeDetail;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function detail(currentPersonID: number | null = 12): MergeDetail {
  const value = {
    merge: { ...mergeResult(person(7)).merge, actor: 'user', current_person_id: currentPersonID ?? undefined },
    participants: [
      { merge_id: 41, participant_id: 701, origin_side: 'absorbed' },
      { merge_id: 41, participant_id: 702, origin_side: 'survivor' },
      { merge_id: 41, participant_id: 703, origin_side: 'absorbed', split_id: 55 },
    ],
    rows: [
      {
        merge_id: 41,
        table_name: 'person_names',
        original_row_key: 'opaque-row-key-must-not-appear',
        snapshot_path: 'private/snapshot/path-must-not-appear',
        action: 'restored',
        origin_side: 'absorbed',
        provenance_kind: 'copied',
        participant_id: 701,
      },
    ],
    splits: [
      {
        id: 55,
        merge_id: 41,
        source_person_id: 12,
        new_person_id: 19,
        new_person_uid: 'synthetic-19',
        source_revision_before: 4,
        source_revision_after: 5,
        exact_reversal: false,
        actor: 'user',
        created_at: '2026-08-04T00:00:00Z',
      },
    ],
    review_candidates: [
      { id: 60, merge_id: 41, person_id: 12, definition_id: 4, survivor_value_id: 84, absorbed_value_id: 85, state: 'pending', created_at: '2026-08-03T00:00:00Z' },
      {
        id: 61,
        merge_id: 41,
        person_id: 12,
        definition_id: 3,
        survivor_value_id: 81,
        absorbed_value_id: 82,
        resolution_value_id: 83,
        state: 'accepted',
        reviewed_at: '2026-08-05T00:00:00Z',
        reviewed_by: 'user',
        created_at: '2026-08-03T00:00:00Z',
      },
    ],
  };
  return { ...value, labels: summary(value as MergeDetail).labels as MergeDetail['labels'] };
}

function summary(mergeDetail: MergeDetail) {
  return {
    merge: mergeDetail.merge,
    labels: {
      profiles: [{ id: 7, display_name: 'Alex Example', participant_ids: [702] }, { id: 9, display_name: 'Alex Example · work', participant_ids: [701, 703] }],
      participants: mergeDetail.participants, members: [], incomplete: false,
      identifiers: [701, 702, 703].flatMap(participant_id => [
        { participant_id, type: 'email', value: `address${participant_id}@example.org` },
        ...(participant_id === 701 ? [{ participant_id, type: 'phone', value: '+12025550101' }] : []),
      ]).map(identifier => ({ display_value: '', normalized_value: identifier.value, service_slug: identifier.type, service_label: identifier.type, scope_kind: '', scope_value: '', ...identifier })),
    },
    participant_count: 2,
    pending_candidate_count: 0,
    row_action_counts: { restored: 1 },
    row_count: 1,
    split_count: 1,
  };
}

function renderHistory(currentPersonID: number | null = 12, options: { gone?: boolean; empty?: boolean; fail?: boolean; unnamed?: boolean } = {}) {
  const mergeDetail = detail(currentPersonID);
  if (options.empty) mergeDetail.participants = [];
  const requests: Request[] = [];
  const fetchFn = vi.fn<typeof fetch>(async (input) => {
    const request = input instanceof Request ? input : new Request(input);
    requests.push(request);
    const path = new URL(request.url).pathname;
    if (path === '/api/v1/people/7/merges') {
      const item = summary(mergeDetail);
      item.labels.incomplete = !!options.fail;
      if (options.gone) item.labels.profiles = item.labels.profiles.filter(profile => profile.id !== 7);
      if (options.fail) item.labels.identifiers = [];
      return Response.json({ merges: [item], limit: 100, offset: 0 });
    }
    if (path === '/api/v1/person-merges/41/snapshot') {
      return Response.json({
        version: 1,
        sha256: 'synthetic-digest',
        snapshot: {
          explicitly_revealed: 'synthetic content',
          persons: [
            ...(options.gone ? [] : [{ id: 7, display_name: 'Alex Example', participant_ids: [702], created_at: '2026-07-19T10:00:00Z' }]),
            { id: 9, display_name: 'Alex Example · work', participant_ids: [701, 703], created_at: '2026-07-20T10:00:00Z' },
          ],
        },
      });
    }
    if (path === '/api/v1/people/7' && options.gone) return Response.json({}, { status: 404 });
    if (path.startsWith('/api/v1/people/')) return Response.json(person(Number(path.split('/').at(-1)), 1, [], path.endsWith('/19') ? options.unnamed ? '' : 'Alex Restored' : 'Alex Example'));
    if (path.startsWith('/api/v1/participants/')) {
      if (options.fail) return Response.json({}, { status: 503 });
      const id = Number(path.split('/').at(-1));
      return Response.json({ identifiers: [
        { participant_id: id, type: 'email', value: `address${id}@example.org` },
        ...(id === 701 ? [{ participant_id: id, type: 'phone', value: '+12025550101' }] : []),
      ] });
    }
    const labels = summary(mergeDetail).labels;
    if (options.gone) labels.profiles = labels.profiles.filter(profile => profile.id !== 7);
    if (options.fail) { labels.identifiers = []; labels.incomplete = true; }
    return Response.json({ ...mergeDetail, labels });
  });
  const onOpenPerson = vi.fn();
  render(PersonMergeHistory, { client: createAPIClient(fetchFn), personID: 7, definitions: [{ id: 3, label: 'Role' }], onOpenPerson });
  return { requests, options, onOpenPerson };
}

function renderRegressionHistory(mergeDetail: MergeDetail, missingDestination = false, unavailableAddresses = false) {
  const item = summary(mergeDetail);
  item.labels.incomplete = unavailableAddresses;
  item.labels.identifiers = unavailableAddresses ? [] : [
    { participant_id: 701, type: 'email', value: 'alex@example.org' },
    { participant_id: 701, type: 'phone', value: '+12025550101', ...{ display_value: '+1 202 555 0101' } },
    { participant_id: 702, type: 'email', value: 'other@example.org' },
    { participant_id: 703, type: 'email', value: 'split@example.org' },
  ].map(identifier => ({ display_value: '', normalized_value: identifier.value, service_slug: identifier.type, service_label: identifier.type, scope_kind: '', scope_value: '', ...identifier }));
  const requests: string[] = [];
  render(PersonMergeHistory, { client: createAPIClient(async input => {
    const request = input instanceof Request ? input : new Request(input);
    const path = new URL(request.url).pathname;
    requests.push(path);
    if (path === '/api/v1/people/7/merges') {
      return Response.json({ merges: [item], limit: 100, offset: 0 });
    }
    if (path === '/api/v1/person-merges/41') return Response.json({ ...mergeDetail, labels: item.labels });
    if (path.endsWith('/snapshot')) return Response.json({ snapshot: { persons: [{ id: 7, display_name: 'Alex Example' }, { id: 9, display_name: 'Alex Example · work', participant_ids: [701, 703] }] } });
    if (path === '/api/v1/people/19' && missingDestination) return Response.json({}, { status: 404 });
    if (path.startsWith('/api/v1/people/')) {
      const id = Number(path.split('/').at(-1));
      return Response.json(person(id, 4, [701], id === 19 ? 'Alex Restored' : 'Alex Example'), { headers: { ETag: `"person-${id}-r4"` } });
    }
    if (path.startsWith('/api/v1/participants/') && unavailableAddresses) return Response.json({}, { status: 503 });
    if (path === '/api/v1/participants/701') return Response.json({ identifiers: [
      { participant_id: 701, type: 'email', value: 'alex@example.org' },
      { participant_id: 701, type: 'phone', value: '+12025550101', ...{ display_value: '+1 202 555 0101' } },
    ] });
    if (path === '/api/v1/participants/703') return Response.json({ identifiers: [{ participant_id: 703, type: 'email', value: 'split@example.org' }] });
    if (path === '/api/v1/participants/702') return Response.json({ identifiers: [{ participant_id: 702, type: 'email', value: 'other@example.org' }] });
    throw new Error(`Unexpected request: ${path}`);
  }), personID: 7 });
  return { requests };
}

describe('PersonMergeHistory', () => {
  it('shows imported sender addresses on the merge cards without identifier rows', async () => {
    const mergeDetail = detail();
    mergeDetail.labels = {
      profiles: [{ id: 9, display_name: 'Neri Bloom', participant_ids: [701] }, { id: 7, display_name: 'Mira Vale', participant_ids: [702] }], participants: mergeDetail.participants, identifiers: [], incomplete: false,
      members: [701, 702].map(participant_id => ({ participant_id, display_name: 'Named sender', email: `imported${participant_id}@example.org`, normalized_value: `imported${participant_id}@example.org` })),
    };
    render(PersonMergeHistory, { personID: 7, client: createAPIClient(async input => {
      const path = new URL((input as Request).url).pathname;
      if (path.endsWith('/merges')) return Response.json({ merges: [{ ...summary(mergeDetail), labels: {
        profiles: [{ id: 9, display_name: 'Neri Bloom', participant_ids: [701] }, { id: 7, display_name: 'Mira Vale', participant_ids: [702] }], participants: mergeDetail.participants, identifiers: [], incomplete: false,
        members: [701, 702].map(participant_id => ({ participant_id, display_name: 'Named sender', email: `imported${participant_id}@example.org` })),
      } }], limit: 100, offset: 0 });
      if (path.endsWith('/snapshot')) return Response.json({ snapshot: { persons: [{ id: 9, display_name: 'Neri Bloom', participant_ids: [701] }, { id: 7, display_name: 'Mira Vale', participant_ids: [702] }] } });
      if (path === '/api/v1/person-merges/41') return Response.json(mergeDetail);
      if (path.startsWith('/api/v1/participants/')) {
        const id = Number(path.split('/').at(-1));
        return Response.json({ identifiers: [], participant: { participant_id: id, display_name: 'Named sender', email: `imported${id}@example.org` } });
      }
      return Response.json(person(19, 1, [], 'Restored person'));
    }) });
    await fireEvent.click(await screen.findByRole('button', { name: /^Open .+ merged into .+/ }));
    const cards = within(await screen.findByRole('group', { name: 'Merged profiles' }));
    expect(cards.getByText('imported701@example.org')).toBeDefined();
    expect(cards.getByText('imported702@example.org')).toBeDefined();
  });

  it('shows the formatted phone once on a merge card', async () => {
    renderRegressionHistory(detail());
    await fireEvent.click(await screen.findByRole('button', { name: /^Open alex@example.org merged into Alex Example · / }));
    const cards = within(await screen.findByRole('group', { name: 'Merged profiles' }));
    expect(cards.getByText('+1 202 555 0101')).toBeDefined();
    expect(cards.queryByText('+12025550101')).toBeNull();
  });

  it('keeps keyboard focus inside History when opening a merge step', async () => {
    renderRegressionHistory(detail());
    const row = await screen.findByRole('button', { name: /^Open .+ merged into .+ · / });
    row.focus();
    await fireEvent.click(row);
    await screen.findByRole('group', { name: 'Merged profiles' });
    expect(screen.getByRole('dialog').contains(document.activeElement)).toBe(true);
  });

  it('waits for detail before showing its Split action', async () => {
    let release!: (response: Response) => void;
    const pending = new Promise<Response>(resolve => { release = resolve; });
    const merge = detail();
    render(PersonMergeHistory, { personID: 7, client: createAPIClient(async input => {
      const path = new URL((input as Request).url).pathname;
      if (path.endsWith('/merges')) return Response.json({ merges: [summary(merge)], offset: 0, limit: 100 });
      if (path === '/api/v1/person-merges/41') return pending;
      return Response.json({ identifiers: [] });
    }) });
    try {
      await fireEvent.click(await screen.findByRole('button', { name: /^Open .+ merged into .+/ }));
      expect(screen.queryByRole('button', { name: 'Split…' })).toBeNull();
      expect(screen.getByText('Loading merge…', { selector: 'p' })).toBeDefined();
      expect(screen.queryByRole('button', { name: 'another profile' })).toBeNull();
      expect(screen.queryByRole('heading', { name: 'Splits' })).toBeNull();
    } finally {
      release(Response.json(merge));
    }
  });

  it('shows loading until the page with its recorded names arrives', async () => {
    let resolve!: (response: Response) => void;
    const pending = new Promise<Response>(done => { resolve = done; });
    render(PersonMergeHistory, { client: createAPIClient(async () => pending), personID: 7 });
    expect(await screen.findByText('Loading merges…')).toBeDefined();
    expect(screen.queryByText('Merged-in profile merged into this profile')).toBeNull();
    resolve(Response.json({ merges: [summary(detail())], limit: 100, offset: 0 }));
    expect(await screen.findByText('address701@example.org merged into Alex Example')).toBeDefined();
  });

  it('keeps each merge’s recorded survivor even after that profile was merged away', async () => {
    const merges = [detail(), detail()];
    merges[1].merge.id = 42;
    for (const merge of merges) merge.labels.profiles = [{ id: 9, display_name: 'Neri Bloom', participant_ids: [701] }, { id: 7, display_name: merge.merge.id === 41 ? 'Mira Vale' : 'Mira Vale renamed', participant_ids: [702] }];
    render(PersonMergeHistory, { client: createAPIClient(async input => {
      const path = new URL((input as Request).url).pathname;
      if (path.endsWith('/merges')) return Response.json({ merges: merges.map(merge => ({ ...summary(merge), labels: { ...summary(merge).labels, profiles: [{ id: 9, display_name: 'Neri Bloom', participant_ids: [701] }, { id: 7, display_name: merge.merge.id === 41 ? 'Mira Vale' : 'Mira Vale renamed', participant_ids: [702] }] } })), limit: 100, offset: 0 });
      if (path.endsWith('/snapshot')) return Response.json({ snapshot: { persons: [
        { id: 9, display_name: 'Neri Bloom', participant_ids: [701] },
        { id: 7, display_name: path.includes('/41/') ? 'Mira Vale' : 'Mira Vale renamed' },
      ] } });
      if (path.includes('/person-merges/')) return Response.json(path.endsWith('/41') ? merges[0] : merges[1]);
      if (path.includes('/people/')) return Response.json({}, { status: 404 });
      return Response.json({ identifiers: [{ participant_id: 701, type: 'email', value: 'neri@example.org' }] });
    }), personID: 7 });
    expect(await screen.findByText('Neri Bloom merged into Mira Vale')).toBeDefined();
    expect(await screen.findByText('Neri Bloom merged into Mira Vale renamed')).toBeDefined();
    await fireEvent.click(screen.getByRole('button', { name: /^Open Neri Bloom merged into Mira Vale · / }));
    const cards = within(await screen.findByRole('group', { name: 'Merged profiles' })).getAllByRole('region');
    expect(within(cards[1]).getByRole('heading').textContent).toBe('Mira Vale');
  });
  it('keeps every handle and workspace under an unnamed service profile', async () => {
    const merge = detail();
    merge.labels = { profiles: [{ id: 7, display_name: 'Mira Vale', participant_ids: [702] }, { id: 9, participant_ids: [701, 703] }], participants: merge.participants, members: [], incomplete: false,
      identifiers: [701, 703].map(participant_id => ({ participant_id, type: 'handle', service_slug: 'slack', service_label: 'Slack', value: participant_id === 701 ? 'neri' : 'bloom', normalized_value: participant_id === 701 ? 'neri' : 'bloom', display_value: '', scope_kind: 'workspace', scope_value: participant_id === 701 ? 'garden-club' : 'seed-exchange' })) };

    merge.participants = [701, 703].map(participant_id => ({ merge_id: 41, participant_id, origin_side: 'absorbed' }));
    merge.splits = [];
    render(PersonMergeHistory, { client: createAPIClient(async input => {
      const path = new URL((input as Request).url).pathname;
      if (path.endsWith('/merges')) return Response.json({ merges: [{ ...summary(merge), labels: {
        profiles: [{ id: 7, display_name: 'Mira Vale', participant_ids: [] }, { id: 9, participant_ids: [701, 703] }], participants: merge.participants, members: [], incomplete: false,
        identifiers: [701, 703].map(participant_id => ({ participant_id, type: 'handle', service_label: 'Slack', value: participant_id === 701 ? 'neri' : 'bloom', scope_kind: 'workspace', scope_value: participant_id === 701 ? 'garden-club' : 'seed-exchange' })),
      } }], limit: 100, offset: 0 });
      if (path.endsWith('/snapshot')) return Response.json({ snapshot: { persons: [{ id: 7, display_name: 'Mira Vale' }, { id: 9, participant_ids: [701, 703] }] } });
      if (path.includes('/person-merges/')) return Response.json(merge);
      const id = Number(path.split('/').at(-1));
      return Response.json({ identifiers: [{ participant_id: id, type: 'handle', service_label: 'Slack', value: id === 701 ? 'neri' : 'bloom', scope_kind: 'workspace', scope_value: id === 701 ? 'garden-club' : 'seed-exchange' }] });
    }), personID: 7 });
    await fireEvent.click(await screen.findByRole('button', { name: /^Open Slack · neri · workspace: garden-club merged into Mira Vale · / }));
    const card = within((await screen.findByRole('group', { name: 'Merged profiles' })).querySelector('section')!);
    expect(card.getByRole('heading', { name: 'Slack · neri · workspace: garden-club' })).toBeDefined();
    expect(card.getByText('bloom · workspace: seed-exchange')).toBeDefined();
  });
  it('names a same-name absorbed profile by its first address in the merge row', async () => {
    renderRegressionHistory(detail());
    expect(await screen.findByText('alex@example.org merged into Alex Example')).toBeDefined();
    // What the merge brought in, not both sides' total of 2.
    expect(await screen.findByText(/^(Jul|Aug) \d{1,2} · 2 addresses moved in · split back once$/)).toBeDefined();
  });

  it('keeps recorded same-name profiles when addresses are unavailable', async () => {
    renderRegressionHistory(detail(), false, true);
    const row = await screen.findByRole('button', { name: /^Open Alex Example · work merged into Alex Example · / });
    await fireEvent.click(row);
    expect(await screen.findByRole('heading', { name: 'Alex Example · work merged into Alex Example' })).toBeDefined();
    expect(await screen.findByRole('heading', { name: 'Alex Example · work' })).toBeDefined();
  });

  it('ties split addresses to a profile when its destination was deleted', async () => {
    renderRegressionHistory(detail(), true);
    await fireEvent.click(await screen.findByRole('button', { name: /^Open .+ merged into .+ · / }));
    expect(await screen.findByRole('button', { name: 'another profile' })).toBeDefined();
    expect(screen.getByText((_, element) => element?.tagName === 'P' && / · split back to another profile on Aug [34] · partly restored$/.test((element.textContent ?? '').replace(/\s+/g, ' ').trim()))).toBeDefined();
  });

  it('keeps a Splits row for a split no card address names', async () => {
    const mergeDetail = detail();
    mergeDetail.participants = mergeDetail.participants!.map(participant => ({ ...participant, split_id: undefined }));
    renderRegressionHistory(mergeDetail);
    await fireEvent.click(await screen.findByRole('button', { name: /^Open .+ merged into .+ · / }));
    expect(await screen.findByRole('heading', { name: 'Splits' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Open Alex Restored' })).toBeDefined();
    expect(screen.getByText(/^You · Aug [34] · partly restored$/)).toBeDefined();
  });

  it('titles a section containing only decided candidates Review decisions', async () => {
    const mergeDetail = detail();
    mergeDetail.review_candidates = mergeDetail.review_candidates!.filter(candidate => candidate.state !== 'pending');
    renderRegressionHistory(mergeDetail);
    await fireEvent.click(await screen.findByRole('button', { name: /^Open .+ merged into .+ · / }));
    expect(await screen.findByRole('heading', { name: 'Review decisions' })).toBeDefined();
    expect(screen.queryByRole('heading', { name: 'Needs review' })).toBeNull();
  });

  it('groups addresses, splits, and review decisions like profile history', async () => {
    const { onOpenPerson } = renderHistory();
    await fireEvent.click(await screen.findByRole('button', { name: /^Open .+ merged into .+ · / }));
    await screen.findByRole('heading', { name: 'address701@example.org merged into Alex Example' });
    expect(screen.getByRole('button', { name: 'Back to History' })).toBeDefined();
    expect(await screen.findByRole('heading', { name: 'Needs review' })).toBeDefined();
    expect(screen.queryByRole('heading', { name: 'Review decisions' })).toBeNull();
    expect(screen.getByText(/^Merged by you · Aug [23]$/, { selector: 'span' })).toBeDefined();
    // Two cards: the merged-in profile, then the one it merged into.
    const [absorbed, survivor] = within(await screen.findByRole('group', { name: 'Merged profiles' })).getAllByRole('region');
    // A same-name absorbed profile is headed by its first address, which its list then leaves out.
    expect(within(absorbed).getByRole('heading').textContent).toBe('address701@example.org');
    expect(within(absorbed).getAllByText('address701@example.org')).toHaveLength(1);
    expect(within(absorbed).getByText('+12025550101')).toBeDefined();
    expect(within(survivor).getByText('address702@example.org')).toBeDefined();
    // The split shows once, on the merge line: to whom, when, and how; the cards carry no tag for it.
    expect(within(survivor).queryByRole('button')).toBeNull();
    expect(screen.getByText((_, element) => element?.tagName === 'P' && /^Merged by you · Aug [23] · split back to Alex Restored on Aug [34] · partly restored$/.test((element.textContent ?? '').replace(/\s+/g, ' ').trim()))).toBeDefined();
    expect(await screen.findByRole('button', { name: 'Alex Restored' })).toBeDefined();
    expect(screen.queryByRole('heading', { name: 'Splits' })).toBeNull();
    expect(screen.getByText('Waiting for review')).toBeDefined();
    expect(screen.getByText('Field')).toBeDefined();
    await fireEvent.click(screen.getByText('1 earlier decision'));
    expect(screen.getByText('Role')).toBeDefined();
    expect(screen.getByText(/^Accepted by you · Aug [45]$/)).toBeDefined();
    expect(screen.queryByRole('table')).toBeNull();
    expect(document.body.textContent).not.toContain('opaque-row-key-must-not-appear');
    expect(document.body.textContent).not.toContain('private/snapshot/path-must-not-appear');
    await fireEvent.click(screen.getByRole('button', { name: 'Alex Restored' }));
    expect(onOpenPerson).toHaveBeenCalledWith(19);
  });

  it('uses both surviving-profile fallbacks after a 404', async () => {
    renderHistory(12, { gone: true });
    await fireEvent.click(await screen.findByRole('button', { name: /^Open .+ merged into .+ · / }));
    await screen.findByRole('heading', { name: 'Alex Example · work merged into this profile' });
    expect(await screen.findByRole('heading', { name: 'This profile' })).toBeDefined();
  });

  it('explains a merge with no message addresses', async () => {
    renderHistory(12, { empty: true });
    await fireEvent.click(await screen.findByRole('button', { name: /^Open .+ merged into .+ · / }));
    await waitFor(() => expect(screen.getAllByText('No addresses')).toHaveLength(2));
  });

  it('keeps available labels and retries a failed address lookup', async () => {
    const { options } = renderHistory(12, { fail: true });
    await fireEvent.click(await screen.findByRole('button', { name: /^Open .+ merged into .+ · / }));
    expect((await screen.findAllByText('Unknown address')).length).toBeGreaterThan(0);
    expect(screen.getByText("Some names and addresses couldn't be loaded.")).toBeDefined();
    options.fail = false;
    await fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('address701@example.org')).toBeDefined();
    expect(screen.queryByText(/couldn't be loaded/)).toBeNull();
  });

  it('reveals the profile at merge time only after the explicit action', async () => {
    renderHistory();
    await fireEvent.click(await screen.findByRole('button', { name: /^Open .+ merged into .+ · / }));

    expect(screen.queryByText(/explicitly_revealed/)).toBeNull();
    await screen.findByRole('group', { name: 'Merged profiles' });
    await fireEvent.click(await screen.findByText('Profile at merge time'));

    expect(await screen.findByRole('heading', { name: 'Raw values' })).toBeDefined();
    expect((await screen.findByRole('region', { name: 'Raw values at merge time' })).textContent).toContain('explicitly_revealed');
    expect(screen.getByText(/^Captured Aug [23], \d{1,2}:\d{2}\s?[AP]M$/)).toBeDefined();
    expect(screen.getByText('SHA-256 syntheti…').title).toBe('SHA-256 synthetic-digest');
  });

  it('explains why Split is unavailable when the surviving profile is gone', async () => {
    renderHistory(null);
    await fireEvent.click(await screen.findByRole('button', { name: /^Open .+ merged into .+ · / }));
    expect(await screen.findByText((_, element) => element?.tagName === 'P' && /the profile it merged into is gone$/.test(element.textContent ?? ''))).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Split…' })).toBeNull();
  });

  it('explains when all absorbed addresses have already been split out', async () => {
    const value = detail();
    value.participants![0].split_id = 55;
    renderRegressionHistory(value);
    await fireEvent.click(await screen.findByRole('button', { name: /^Open .+ merged into .+ · / }));
    expect(await screen.findByText((_, element) => element?.tagName === 'P' && / · nothing left to split$/.test(element.textContent ?? ''))).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Split…' })).toBeNull();
  });

  it('says the split and why Split… is absent once, without a second date on the same day', async () => {
    // A split back on the merge's own day, with the profile it merged into gone: nothing is left either way.
    const value = detail(null);
    value.participants![0].split_id = 55;
    value.splits = [{ ...value.splits![0], exact_reversal: true, created_at: value.merge.created_at }];
    renderRegressionHistory(value);
    await fireEvent.click(await screen.findByRole('button', { name: /^Open .+ merged into .+ · / }));
    expect(await screen.findByText((_, element) => element?.tagName === 'P' && /^Merged by you · (Jul|Aug) \d{1,2} · split back to Alex Restored · nothing left to split$/.test((element.textContent ?? '').replace(/\s+/g, ' ').trim()))).toBeDefined();
  });

  it('returns from Split to the merge in the same dialog', async () => {
    const mergeDetail = detail();
    const fetchFn = vi.fn<typeof fetch>(async (input) => {
      const request = input instanceof Request ? input : new Request(input);
      const path = new URL(request.url).pathname;
      if (path.endsWith('/merges')) return Response.json({ merges: [summary(mergeDetail)], limit: 100, offset: 0 });
      if (path === '/api/v1/people/12') {
        return Response.json(
          {
            id: 12,
            revision: 4,
            display_name: 'Synthetic Source',
            participant_ids: [701],
            created_at: '2026-08-01T00:00:00Z',
            updated_at: '2026-08-02T00:00:00Z',
            vcard_uid: 'synthetic-12',
          },
          { headers: { ETag: '"person-12-r4"' } },
        );
      }
      if (path === '/api/v1/person-merges/41') return Response.json(mergeDetail);
      if (path.startsWith('/api/v1/people/')) return Response.json(person(Number(path.split('/').at(-1)), 1, [], ''));
      if (path.startsWith('/api/v1/participants/')) return Response.json({ identifiers: [] });
      throw new Error(`Unexpected request: ${path}`);
    });
    render(PersonMergeHistory, { client: createAPIClient(fetchFn), personID: 7 });
    await fireEvent.click(await screen.findByRole('button', { name: /^Open .+ merged into .+ · / }));
    const trigger = await screen.findByRole('button', { name: 'Split…' });
    await fireEvent.click(trigger);
    await screen.findByRole('dialog', { name: 'Split Synthetic Source' });
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    const cancel = screen.getByRole('button', { name: /^Back to .+ merged into / });
    await waitFor(() => expect(cancel).toHaveProperty('disabled', false));

    await fireEvent.click(cancel);

    expect(await screen.findByRole('button', { name: 'Split…' })).toBeDefined();
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
  });
});
