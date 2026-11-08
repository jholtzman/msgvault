import { mergeResult, person } from '../../directory/entity-fixtures.test-support';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createAPIClient } from '../../api/client';
import type { PersonMergeDetail as GeneratedPersonMergeDetail } from '../../api/generated/models';
import { PersonMergeHistoryController } from '../../directory/person-merge-history-controller.svelte';
import PersonSplitSteps from './PersonSplitSteps.svelte';

type MergeDetail = GeneratedPersonMergeDetail;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function mergeDetail(
  participants: MergeDetail['participants'] = [{ merge_id: 41, participant_id: 701, origin_side: 'absorbed' }],
): MergeDetail {
  return {
    merge: { ...mergeResult(person(7)).merge, current_person_id: 12 },
    labels: { profiles: [], participants, members: [], identifiers: [], incomplete: true },
    participants,
    rows: [],
    splits: [],
    review_candidates: [],
  };
}

async function preparedController(fetchFn: typeof fetch, participants?: MergeDetail['participants'], labels?: () => MergeDetail['labels']) {
  const value = mergeDetail(participants);
  const routedFetch = vi.fn<typeof fetch>(async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    if (new URL(request.url).pathname === '/api/v1/person-merges/41') return Response.json({ ...value, labels: labels?.() ?? value.labels });
    return fetchFn(request);
  });
  const controller = new PersonMergeHistoryController(createAPIClient(routedFetch), 7);
  await controller.selectMerge(41);
  await controller.openSplit();
  return { controller };
}

function sourceResponse() {
  return Response.json(
    { ...person(12, 4, [701], 'Synthetic Source'), created_at: '2026-08-01T00:00:00Z', updated_at: '2026-08-02T00:00:00Z' },
    { headers: { ETag: '"person-12-r4"' } },
  );
}

function result(exactReversal: boolean) {
  return {
    exact_reversal: exactReversal,
    cache_state: 'ready',
    identity_revision: 8,
    source_person: { ...person(12, 5, [], 'Synthetic Source'), created_at: '2026-08-01T00:00:00Z', updated_at: '2026-08-04T00:00:00Z' },
    new_person: { ...person(19, 1, [701], 'Synthetic Restored'), created_at: '2026-08-04T00:00:00Z', updated_at: '2026-08-04T00:00:00Z' },
    split: {
      id: 55,
      merge_id: 41,
      source_person_id: 12,
      new_person_id: 19,
      new_person_uid: 'synthetic-19',
      source_revision_before: 4,
      source_revision_after: 5,
      exact_reversal: exactReversal,
      actor: 'web',
      created_at: '2026-08-04T00:00:00Z',
    },
    ambiguous_rows: exactReversal
      ? []
      : [{ table_name: 'person_names', original_row_key: 'concealed-key', action: 'ambiguous' }],
    unrestored_rows: [],
    uid_alias_disposition: 'restored',
  };
}

describe('PersonSplitSteps', () => {
  it('shows choices only after every source address is labeled and accepts the first click', async () => {
    let release!: (value: Response) => void;
    const late = new Promise<Response>(resolve => { release = resolve; });
    const controller = new PersonMergeHistoryController(createAPIClient(async input => {
      const path = new URL((input as Request).url).pathname;
      if (path.endsWith('/person-merges/41')) return Response.json({ ...mergeDetail(), labels: { ...mergeDetail().labels, incomplete: false, members: [{ participant_id: 701, email: 'neri@example.org' }, { participant_id: 999, email: 'mira@example.org' }] } });
      if (path.endsWith('/people/12')) return late;
      return Response.json({ identifiers: [], participant: { participant_id: 701, display_name: 'Neri Bloom', email: 'neri@example.org' } });
    }), 7);
    await controller.selectMerge(41);
    render(PersonSplitSteps, { controller, onOpenPerson: vi.fn() });
    const opened = controller.openSplit();
    await waitFor(() => expect(controller.sourceLoading).toBe(true));
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(screen.getByText('Loading this profile…')).toBeDefined();
    release(Response.json(person(12, 4, [701, 999]), { headers: { ETag: '"person-12-r4"' } }));
    await opened;
    await fireEvent.click(await screen.findByRole('checkbox', { name: 'neri@example.org' }));
    expect(controller.selectedParticipantIDs).toEqual([701]);
    expect(within(screen.getByRole('group', { name: 'After the split' })).getByText('mira@example.org')).toBeDefined();
    expect(controller.confirmSplit()).toBe(true);
    controller.destroy();
  });

  it('names the actual source and selection in confirmation, then shows two fresh navigation actions with partial copy', async () => {
    const fetchFn = vi.fn<typeof fetch>(async (input) => {
      const request = input instanceof Request ? input : new Request(input);
      const path = new URL(request.url).pathname;
      if (path === '/api/v1/participants/701') return Response.json({ identifiers: [
        { participant_id: 701, type: 'email', value: 'alex@example.org' },
        { participant_id: 701, type: 'phone', value: '+12025550101' },
      ] });
      if (path === '/api/v1/people/7') return Response.json(person(7));
      return request.method === 'GET' ? sourceResponse() : Response.json(result(false));
    });
    const { controller } = await preparedController(fetchFn, undefined, () => ({ ...mergeDetail().labels, incomplete: false, identifiers: [
      { participant_id: 701, type: 'email', value: 'alex@example.org', normalized_value: 'alex@example.org', display_value: '', service_slug: 'email', service_label: 'Email', scope_kind: '', scope_value: '' },
      { participant_id: 701, type: 'phone', value: '+12025550101', normalized_value: '+12025550101', display_value: '', service_slug: 'phone', service_label: 'Phone', scope_kind: '', scope_value: '' },
    ] }));
    const onOpenPerson = vi.fn();
    render(PersonSplitSteps, { controller, onOpenPerson });

    const label = 'alex@example.org, +12025550101';
    expect(screen.getByText('None chosen yet')).toBeDefined();
    await fireEvent.click(screen.getByRole('checkbox', { name: label }));
    expect(screen.getByRole('group', { name: 'Addresses to move' })).toBeDefined();
    const [stays, moves] = within(screen.getByRole('group', { name: 'After the split' })).getAllByRole('region');
    expect(within(stays).getByRole('heading').textContent).toBe('Stays with Synthetic Source');
    expect(within(moves).getByRole('heading').textContent).toBe('New person');
    expect(within(moves).getByText(label)).toBeDefined();
    expect(within(stays).queryByText(label)).toBeNull();
    await act(() => { controller.confirmSplit(); return controller.submitSplit(); });

    expect(await screen.findByRole('button', { name: 'Open Synthetic Restored' })).toBeDefined();
    expect(document.body.textContent?.toLowerCase()).not.toContain('undo');
    // The partial-restore lines are shown under the two people, not folded away.
    const details = screen.getAllByRole('listitem').map(item => item.textContent);
    expect(details).toEqual(['Partly restored', "1 record couldn't be matched", 'Links to the merged-in profile still open Synthetic Source']);
    expect(screen.getByText('Partly restored').closest('details')).toBeNull();
    expect(screen.getByLabelText('Split result people').compareDocumentPosition(screen.getByRole('list')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByText(`New person · ${label}`)).toBeDefined();
    expect(screen.getByText('Stays')).toBeDefined();
    expect(document.body.textContent).not.toMatch(/concealed-key|uid alias|restored$/i);
    await fireEvent.click(screen.getByRole('button', { name: 'Open Synthetic Source' }));
    await fireEvent.click(screen.getByRole('button', { name: 'Open Synthetic Restored' }));
    expect(onOpenPerson.mock.calls).toEqual([[12], [19]]);
  });

  it('keeps linked service handles and their scopes', async () => {
    const fetchFn = vi.fn<typeof fetch>(async (input) => {
      const request = input instanceof Request ? input : new Request(input);
      const path = new URL(request.url).pathname;
      if (path.startsWith('/api/v1/participants/')) {
        const id = Number(path.split('/').at(-1));
        return Response.json({ identifiers: [{ participant_id: id, type: 'slack', service_label: 'Slack', value: id === 701 ? 'alex' : 'alex.work', scope_kind: 'workspace', scope_value: id === 701 ? 'garden-club' : 'book-club' }] });
      }
      if (path === '/api/v1/people/7') return Response.json(person(7));
      return sourceResponse();
    });
    const { controller } = await preparedController(fetchFn, [
      { merge_id: 41, participant_id: 701, origin_side: 'absorbed' },
      { merge_id: 41, participant_id: 702, origin_side: 'absorbed' },
    ], () => ({ ...mergeDetail().labels, incomplete: false, identifiers: [
      { participant_id: 701, type: 'slack', service_slug: 'slack', service_label: 'Slack', value: 'alex', normalized_value: 'alex', display_value: '', scope_kind: 'workspace', scope_value: 'garden-club' },
      { participant_id: 702, type: 'slack', service_slug: 'slack', service_label: 'Slack', value: 'alex.work', normalized_value: 'alex.work', display_value: '', scope_kind: 'workspace', scope_value: 'book-club' },
    ] }));
    render(PersonSplitSteps, { controller, onOpenPerson: vi.fn() });
    const boxes = within(screen.getByRole('group', { name: 'Addresses to move' })).getAllByRole('checkbox');
    expect(boxes.map(box => box.getAttribute('aria-label') ?? box.closest('label')?.textContent?.trim())).toEqual([
      'Slack · alex · workspace: garden-club', 'Slack · alex.work · workspace: book-club',
    ]);
  });

  it.each([false, true])('splits selected unknown addresses when Retry recovers labels=%s', async recover => {
    let unavailable = true;
    const posts: unknown[] = [];
    const participants = [701, 702].map(participant_id => ({ merge_id: 41, participant_id, origin_side: 'absorbed' }));
    const { controller } = await preparedController(async input => {
      const request = input as Request;
      const path = new URL(request.url).pathname;
      if (path.includes('/participants/')) {
        if (unavailable) return Response.json({}, { status: 503 });
        const id = Number(path.split('/').at(-1));
        return Response.json({ identifiers: [{ participant_id: id, type: 'email', value: `address${id}@example.org` }] });
      }
      if (request.method === 'POST') {
        posts.push(await request.json());
        return Response.json({ ...result(true), source_person: person(12, 5, [701], 'Synthetic Source'), new_person: person(19, 1, [702], 'Synthetic Restored') });
      }
      return Response.json(person(12, 4, [701, 702], 'Synthetic Source'), { headers: { ETag: '"person-12-r4"' } });
    }, participants, () => ({ ...mergeDetail(participants).labels, incomplete: unavailable, members: unavailable ? [] : [
      { participant_id: 701, email: 'address701@example.org', normalized_value: 'address701@example.org' },
      { participant_id: 702, email: 'address702@example.org', normalized_value: 'address702@example.org' },
    ] }));
    render(PersonSplitSteps, { controller, onOpenPerson: vi.fn() });
    expect(screen.getByText("Some addresses couldn't be loaded.")).toBeDefined();
    expect(screen.getByRole('checkbox', { name: 'Unknown address 1' })).toHaveProperty('disabled', false);
    await fireEvent.click(screen.getByRole('checkbox', { name: 'Unknown address 2' }));
    if (recover) {
      unavailable = false;
      await fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
      await waitFor(() => expect(screen.getByRole('checkbox', { name: 'address702@example.org' })).toHaveProperty('checked', true));
    }
    await act(() => { controller.confirmSplit(); return controller.submitSplit(); });
    expect(await screen.findByRole('button', { name: 'Open Synthetic Restored' })).toBeDefined();
    expect(posts).toEqual([{ merge_id: 41, participant_ids: [702] }]);
    expect(screen.getByText(recover ? 'New person · address702@example.org' : 'New person · Unknown address 2')).toBeDefined();
  });

  it('distinguishes a participant with no stored address from a failed identity lookup', async () => {
    const { controller } = await preparedController(async () => sourceResponse(), undefined, () => ({ ...mergeDetail().labels, incomplete: false, members: [{ participant_id: 701, display_name: 'No stored address' }] }));
    render(PersonSplitSteps, { controller, onOpenPerson: vi.fn() });
    expect(screen.getByRole('checkbox', { name: 'No addresses' })).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });

  it('allows an explicitly confirmed empty absorbed lineage', async () => {
    const fetchFn = vi.fn<typeof fetch>(async (input) => {
      const request = input instanceof Request ? input : new Request(input);
      return request.method === 'GET' ? sourceResponse() : Response.json(result(true));
    });
    const { controller } = await preparedController(fetchFn, []);
    render(PersonSplitSteps, { controller, onOpenPerson: vi.fn() });

    expect(screen.getByText(/This merge has no addresses/)).toBeDefined();
  });

  it('disables the address selection while the split is submitted', async () => {
    let resolve!: (response: Response) => void;
    const { controller } = await preparedController(async input => (input as Request).method === 'GET' ? sourceResponse() : new Promise<Response>(done => resolve = done));
    render(PersonSplitSteps, { controller, onOpenPerson: vi.fn() });
    await fireEvent.click(screen.getByRole('checkbox', { name: 'Unknown address 1' }));
    let submitted!: Promise<void>;
    await act(() => { controller.confirmSplit(); submitted = controller.submitSplit(); });
    expect(screen.getByRole('checkbox', { name: 'Unknown address 1' })).toHaveProperty('disabled', true);
    resolve(Response.json(result(true)));
    await act(() => submitted);
    expect(await screen.findByRole('button', { name: 'Open Synthetic Restored' })).toBeDefined();
  });

  it('keeps failed stale recovery visibly blocked and focuses the GET-only retry through failure and success', async () => {
    const retrySource = deferredResponse();
    const retryDetail = deferredResponse();
    let sourceReads = 0;
    let detailReads = 0;
    let postAttempts = 0;
    const fetchFn = vi.fn<typeof fetch>(async (input) => {
      const request = input instanceof Request ? input : new Request(input);
      const path = new URL(request.url).pathname;
      if (path.includes('/participants/')) return Response.json({ identifiers: [{ participant_id: Number(path.split('/').at(-1)), type: 'email', value: `person${path.split('/').at(-1)}@example.org` }] });
      if (path === '/api/v1/person-merges/41') {
        detailReads += 1;
        if (detailReads === 2) return Response.json({ ...mergeDetail(), labels: { ...mergeDetail().labels, incomplete: false, members: [{ participant_id: 701, email: 'person701@example.org' }] } });
        if (detailReads === 3) return retryDetail.promise;
        return Response.json({ ...mergeDetail(), labels: { ...mergeDetail().labels, incomplete: false, members: [{ participant_id: 701, email: 'person701@example.org' }] } });
      }
      if (path === '/api/v1/people/12') {
        sourceReads += 1;
        if (sourceReads === 1) return sourceResponse();
        if (sourceReads === 2)
          return Response.json({ error: 'unavailable', message: 'Automatic source reload failed' }, { status: 503 });
        if (sourceReads === 3) return retrySource.promise;
        return Response.json(
          {
            id: 12,
            revision: 6,
            display_name: 'Fresh Synthetic Source',
            participant_ids: [701],
            created_at: '2026-08-01T00:00:00Z',
            updated_at: '2026-08-05T00:00:00Z',
            vcard_uid: 'synthetic-12',
          },
          { headers: { ETag: '"person-12-r6"' } },
        );
      }
      postAttempts += 1;
      return Response.json({ error: 'person_merge_revision_conflict', message: 'Source changed' }, { status: 409 });
    });
    const controller = new PersonMergeHistoryController(createAPIClient(fetchFn), 7);
    await controller.selectMerge(41);
    await controller.openSplit();
    controller.setParticipantSelected(701, true);
    controller.confirmSplit();
    await controller.submitSplit();
    render(PersonSplitSteps, { controller, onOpenPerson: vi.fn() });

    expect(screen.getByText(/^This profile changed since you opened it\.$/)).toBeDefined();

    await fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(controller.sourceLoading).toBe(true));

    retrySource.resolve(Response.json({ error: 'unavailable', message: 'Source still unavailable' }, { status: 503 }));
    retryDetail.resolve(Response.json({ ...mergeDetail(), labels: { ...mergeDetail().labels, incomplete: false, members: [{ participant_id: 701, email: 'person701@example.org' }] } }));
    const retry = await screen.findByRole('button', { name: 'Retry' });
    await waitFor(() => expect(document.activeElement).toBe(retry));

    await fireEvent.click(retry);
    const participant = await screen.findByRole('checkbox', { name: 'person701@example.org' });
    await waitFor(() => expect(document.activeElement).toBe(participant));
    expect(screen.queryByText(/^This profile changed since you opened it\.$/)).toBeNull();
  });
});

function deferredResponse() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}
