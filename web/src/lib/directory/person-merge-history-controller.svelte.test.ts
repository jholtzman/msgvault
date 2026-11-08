import { mergeResult, person, requestOf } from './entity-fixtures.test-support';
import { afterEach, describe, expect, it, vi } from 'vitest';

import * as requestID from '../api/request-id';
import { createAPIClient } from '../api/client';
import type {
  PersonMergeDetail as GeneratedPersonMergeDetail,
  PersonSplitResult as GeneratedPersonSplitResult,
} from '../api/generated/models';
import { PERSON_MERGE_HISTORY_LIMIT, PersonMergeHistoryController } from './person-merge-history-controller.svelte';

type PersonMergeDetail = GeneratedPersonMergeDetail;

afterEach(() => vi.restoreAllMocks());

function detail(
  overrides: Partial<PersonMergeDetail['merge']> = {},
  participants: PersonMergeDetail['participants'] = [
    { merge_id: 41, participant_id: 701, origin_side: 'absorbed' },
    { merge_id: 41, participant_id: 702, origin_side: 'survivor' },
  ],
): PersonMergeDetail {
  return {
    merge: { ...mergeResult(person(7)).merge, current_person_id: 12, ...overrides },
    labels: {
      profiles: [{ id: 7, display_name: 'Recorded Name', participant_ids: [702] }, { id: 9, display_name: 'Absorbed', participant_ids: [701] }],
      participants, members: [], identifiers: [], incomplete: false,
    },
    participants,
    rows: [],
    splits: [],
    review_candidates: [],
  };
}

function summary(id: number) {
  const mergeDetail = detail({ id });
  return {
    merge: mergeDetail.merge,
    labels: { profiles: [], participants: [], members: [], identifiers: [], incomplete: false },
    participant_count: 1,
    pending_candidate_count: 0,
    row_action_counts: { restored: 2 },
    row_count: 2,
    split_count: 0,
  };
}

function splitResult(exact = true): GeneratedPersonSplitResult {
  return {
    exact_reversal: exact,
    cache_state: 'ready',
    identity_revision: 8,
    source_person: person(12, 5, [701, 702], 'Synthetic Source'),
    new_person: person(19, 1, [701, 702], 'Synthetic Restored'),
    split: {
      id: 55,
      merge_id: 41,
      source_person_id: 12,
      new_person_id: 19,
      new_person_uid: 'synthetic-19',
      source_revision_before: 4,
      source_revision_after: 5,
      exact_reversal: exact,
      actor: 'web',
      created_at: '2026-08-04T00:00:00Z',
    },
    ambiguous_rows: exact ? [] : [{ table_name: 'person_names', original_row_key: 'concealed', action: 'ambiguous' }],
    unrestored_rows: [],
    uid_alias_disposition: 'restored',
  };
}

function deferredResponse() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

describe('PersonMergeHistoryController', () => {
  it('uses exact pagination and keeps Previous on a successful empty nonzero page', async () => {
    const requests: Request[] = [];
    const fetchFn = vi.fn<typeof fetch>(async (input) => {
      const request = requestOf(input);
      if (!new URL(request.url).pathname.endsWith('/merges')) return Response.json({}, { status: 503 });
      requests.push(request);
      const offset = Number(new URL(request.url).searchParams.get('offset'));
      const merges =
        offset === 0 ? Array.from({ length: PERSON_MERGE_HISTORY_LIMIT }, (_, index) => summary(index + 1)) : [];
      return Response.json({ merges, limit: PERSON_MERGE_HISTORY_LIMIT, offset });
    });
    const controller = new PersonMergeHistoryController(createAPIClient(fetchFn), 7);

    await controller.loadHistory();
    await controller.nextHistoryPage();

    expect(new URL(requests[0]!.url).searchParams.toString()).toBe('limit=100&offset=0');
    expect(new URL(requests[1]!.url).searchParams.toString()).toBe('limit=100&offset=100');
    expect(controller.history).toEqual([]);
    expect(controller.historyOffset).toBe(100);
    expect(controller.hasPreviousHistoryPage).toBe(true);
    expect(controller.hasNextHistoryPage).toBe(false);
  });

  it('loads every named History row and its addresses in one page request', async () => {
    const paths: string[] = [];
    const controller = new PersonMergeHistoryController(createAPIClient(async input => {
      const path = new URL(requestOf(input).url).pathname;
      paths.push(path);
      if (!path.endsWith('/merges')) throw new Error(`Unexpected ${path}`);
      return Response.json({ merges: Array.from({ length: 100 }, (_, index) => ({ ...summary(index + 1), labels: {
        profiles: [{ id: 7, display_name: 'Recorded survivor', participant_ids: [702] }, { id: 9, display_name: 'Recorded absorbed', participant_ids: [701] }],
        participants: [{ merge_id: index + 1, participant_id: 701, origin_side: 'absorbed' }],
        members: [{ participant_id: 701, email: 'earlier@example.org' }], identifiers: [], incomplete: false,
      } })), limit: 100, offset: 0 });
    }), 12);
    await controller.loadHistory();
    expect(paths).toEqual(['/api/v1/people/12/merges']);
    expect(controller.historyRows.get(100)?.names.get(7)).toBe('Recorded survivor');
    expect(controller.historyRows.get(100)?.names.get(9)).toBe('Recorded absorbed');
    expect(controller.historyRows.get(100)?.count).toBe(1);
    expect(controller.mergedInAddresses.at(-1)?.value).toBe('earlier@example.org');
    controller.destroy();
  });

  it('loads detail without exposing the verified snapshot until an explicit reveal', async () => {
    const requests: Request[] = [];
    const fetchFn = vi.fn<typeof fetch>(async (input) => {
      const request = requestOf(input);
      requests.push(request);
      if (request.url.endsWith('/snapshot'))
        return Response.json({ version: 1, sha256: 'synthetic-digest', snapshot: { private: 'explicit' } });
      if (new URL(request.url).pathname === '/api/v1/person-merges/41') return Response.json(detail());
      if (new URL(request.url).pathname === '/api/v1/people/7') return Response.json(person(7));
      return Response.json({ identifiers: [] });
    });
    const controller = new PersonMergeHistoryController(createAPIClient(fetchFn), 7);

    await controller.selectMerge(41);
    expect(requests.filter(request => new URL(request.url).pathname.startsWith('/api/v1/person-merges/'))
      .map(request => new URL(request.url).pathname)).toEqual(['/api/v1/person-merges/41']);
    expect(controller.snapshot).toBeNull();

    await controller.revealSnapshot();
    await controller.revealSnapshot();
    expect(requests.filter(request => new URL(request.url).pathname.endsWith('/snapshot'))
      .map(request => new URL(request.url).pathname)).toEqual(['/api/v1/person-merges/41/snapshot']);
  });

  it.each(['person', 'merge'])('offers Split during label loading and discards late labels after a newer %s', async replacement => {
    const late = deferredResponse();
    let failReload = false;
    const requests: Request[] = [];
    const controller = new PersonMergeHistoryController(createAPIClient(async input => {
      const request = requestOf(input);
      requests.push(request);
      const path = new URL(request.url).pathname;
      if (path === '/api/v1/person-merges/41') return Response.json({ ...detail(), splits: [splitResult().split] });
      if (path === '/api/v1/people/19') return late.promise;
      if (path === '/api/v1/person-merges/42') return failReload
        ? Response.json({}, { status: 503 })
        : Response.json({ ...detail({ id: 42, survivor_person_id: 8 }, []), labels: { ...detail().labels, profiles: [{ id: 8, display_name: 'New Example', participant_ids: [] }] } });
      if (path === '/api/v1/person-merges/42/snapshot') return Response.json({ snapshot: { persons: [{ id: 8, display_name: 'New Example' }] } });
      return Response.json({ merges: [], identifiers: [] });
    }), 7);
    const first = controller.selectMerge(41);
    await vi.waitFor(() => expect(controller.detail?.merge.id).toBe(41));
    expect(controller.labels).toBeNull();
    expect(controller.detailLoading).toBe(false);
    expect(controller.canOfferSplit).toBe(true);
    if (replacement === 'person') controller.setPerson(8);
    else await controller.selectMerge(42);
    late.resolve(Response.json(person(19, 1, [], 'Late Example')));
    await first;
    expect(requests.find(request => new URL(request.url).pathname === '/api/v1/people/19')?.signal.aborted).toBe(true);
    expect(controller.labels?.names.get(7)).toBeUndefined();
    if (replacement === 'merge') {
      expect(controller.labels?.for).toBe(controller.detail);
      expect(controller.labels?.names.get(8)).toBe('New Example');
      const labels = controller.labels;
      failReload = true;
      await controller.retryDetail();
      expect(controller.detailError).toBeTruthy();
      expect(controller.labels).toBe(labels);
      expect(controller.labels?.for).toBe(controller.detail);
    } else expect(controller.labels).toBeNull();
    controller.destroy();
  });

  it('uses detail current_person_id and its fresh strong ETag for the exact split request', async () => {
    const requests: Request[] = [];
    const fetchFn = vi.fn<typeof fetch>(async (input) => {
      const request = requestOf(input);
      requests.push(request);
      const path = new URL(request.url).pathname;
      if (path === '/api/v1/person-merges/41') return Response.json(detail());
      if (path === '/api/v1/people/12' && request.method === 'GET') {
        return Response.json(person(12, 4, [701, 702], 'Synthetic Source'), { headers: { ETag: '"person-12-r4"' } });
      }
      return Response.json(splitResult(), {
        headers: { ETag: '"person-12-r5"', 'X-New-Person-ETag': '"person-19-r1"' },
      });
    });
    vi.spyOn(requestID, 'createBrowserRequestID').mockReturnValue('123-456-789-12');
    const controller = new PersonMergeHistoryController(createAPIClient(fetchFn), 7);

    await controller.selectMerge(41);
    await controller.openSplit();
    controller.setParticipantSelected(701, true);
    expect(controller.confirmSplit()).toBe(true);
    await controller.submitSplit();

    const post = requests.find((request) => request.method === 'POST')!;
    expect(new URL(post.url).pathname).toBe('/api/v1/people/12/split');
    expect(post.headers.get('If-Match')).toBe('"person-12-r4"');
    expect(post.headers.get('Idempotency-Key')).toBe('123-456-789-12');
    await expect(post.clone().json()).resolves.toEqual({ merge_id: 41, participant_ids: [701] });
  });

  it('requires a regular selection but permits an explicitly confirmed zero-participant lineage', async () => {
    let zeroLineage = true;
    let submitted: Request | undefined;
    const fetchFn = vi.fn<typeof fetch>(async (input) => {
      const request = requestOf(input);
      if(request.method === 'POST') { submitted = request; return Response.json(splitResult()); }
      if (new URL(request.url).pathname === '/api/v1/people/12') {
        return Response.json(person(12, 4, [701, 702], 'Synthetic Person 12'), { headers: { ETag: '"person-12-r4"' } });
      }
      return Response.json(detail({}, zeroLineage ? [] : undefined));
    });
    const controller = new PersonMergeHistoryController(createAPIClient(fetchFn), 7);
    await controller.selectMerge(41);
    await controller.openSplit();

    expect(controller.isZeroParticipantLineage).toBe(true);
    expect(controller.confirmSplit()).toBe(true);
    expect(controller.confirmedParticipantIDs).toEqual([]);
    await controller.submitSplit();
    await expect(submitted!.clone().json()).resolves.toEqual({ merge_id: 41, participant_ids: [] });

    zeroLineage = false;
    const regular = new PersonMergeHistoryController(createAPIClient(fetchFn), 7);
    await regular.selectMerge(41);
    await regular.openSplit();
    expect(regular.confirmSplit()).toBe(false);
  });

  it('reuses a request ID only after a thrown transport failure of the unchanged confirmation', async () => {
    const requests: Request[] = [];
    let postAttempts = 0;
    const fetchFn = vi.fn<typeof fetch>(async (input) => {
      const request = requestOf(input);
      requests.push(request);
      const path = new URL(request.url).pathname;
      if (path === '/api/v1/person-merges/41') return Response.json(detail());
      if (request.method === 'GET') return Response.json(person(12, 4, [701, 702], 'Synthetic Person 12'), { headers: { ETag: '"person-12-r4"' } });
      postAttempts += 1;
      if (postAttempts === 1) throw new TypeError('connection reset');
      return Response.json(splitResult());
    });
    const createRequestID = vi.spyOn(requestID, 'createBrowserRequestID')
      .mockReturnValueOnce('123-456-789-12')
      .mockReturnValueOnce('234-567-890-23');
    const controller = new PersonMergeHistoryController(createAPIClient(fetchFn), 7);
    await controller.selectMerge(41);
    await controller.openSplit();
    controller.setParticipantSelected(701, true);
    controller.confirmSplit();

    await controller.submitSplit();
    await controller.submitSplit();

    expect(createRequestID).toHaveBeenCalledOnce();
    const posts = requests.filter((request) => request.method === 'POST');
    expect(posts.map((request) => request.headers.get('Idempotency-Key'))).toEqual([
      '123-456-789-12',
      '123-456-789-12',
    ]);
  });

  it('rotates the request ID and requires reconfirmation after a thrown non-transport exception', async () => {
    const requests: Request[] = [];
    let postAttempts = 0;
    const fetchFn = vi.fn<typeof fetch>(async (input) => {
      const request = requestOf(input);
      requests.push(request);
      const path = new URL(request.url).pathname;
      if (path === '/api/v1/person-merges/41') return Response.json(detail());
      if (request.method === 'GET') return Response.json(person(12, 4, [701, 702], 'Synthetic Person 12'), { headers: { ETag: '"person-12-r4"' } });
      postAttempts += 1;
      if (postAttempts === 1) throw new SyntaxError('invalid response JSON');
      return Response.json(splitResult());
    });
    vi.spyOn(requestID, 'createBrowserRequestID')
      .mockReturnValueOnce('123-456-789-12')
      .mockReturnValueOnce('234-567-890-23');
    const controller = new PersonMergeHistoryController(createAPIClient(fetchFn), 7);
    await controller.selectMerge(41);
    await controller.openSplit();
    controller.setParticipantSelected(701, true);
    controller.confirmSplit();

    await controller.submitSplit();
    expect(controller.confirmedParticipantIDs).toBeNull();
    controller.confirmSplit();
    await controller.submitSplit();

    expect(
      requests.filter((request) => request.method === 'POST').map((request) => request.headers.get('Idempotency-Key')),
    ).toEqual(['123-456-789-12', '234-567-890-23']);
  });

  it('atomically reloads exact source/detail only for the recognized stale code and requires reconfirmation', async () => {
    const requests: Request[] = [];
    let sourceReads = 0;
    let detailReads = 0;
    const fetchFn = vi.fn<typeof fetch>(async (input) => {
      const request = requestOf(input);
      requests.push(request);
      const path = new URL(request.url).pathname;
      if (path.includes('/participants/')) return Response.json({ identifiers: [{ participant_id: Number(path.split('/').at(-1)), type: 'email', value: `person${path.split('/').at(-1)}@example.org` }] });
      if (path === '/api/v1/person-merges/41') {
        detailReads += 1;
        return Response.json(detail({ survivor_revision_after: detailReads === 1 ? 4 : 5 }));
      }
      if (path === '/api/v1/people/12') {
        sourceReads += 1;
        const revision = sourceReads === 1 ? 4 : 5;
        return Response.json(person(12, revision, [701, 702], 'Synthetic Person 12'), { headers: { ETag: `"person-12-r${revision}"` } });
      }
      return Response.json({ error: 'person_merge_revision_conflict', message: 'Source changed' }, { status: 409 });
    });
    const controller = new PersonMergeHistoryController(createAPIClient(fetchFn), 7);
    await controller.selectMerge(41);
    await controller.openSplit();
    controller.setParticipantSelected(701, true);
    controller.confirmSplit();

    await controller.submitSplit();

    expect(sourceReads).toBe(2);
    expect(detailReads).toBe(2);
    expect(controller.sourcePerson?.revision).toBe(5);
    expect(controller.detail?.merge.survivor_revision_after).toBe(5);
    expect(controller.confirmedParticipantIDs).toBeNull();
    expect(controller.splitError).toBe('This profile changed since you opened it. Check its addresses, then split again.');
    expect(requests.filter((request) => request.method === 'POST')).toHaveLength(1);
  });

  it('blocks stale state after an atomic reload failure until GET-only retry publishes fresh source and detail', async () => {
    const requests: Request[] = [];
    let sourceReads = 0;
    let detailReads = 0;
    let postAttempts = 0;
    const fetchFn = vi.fn<typeof fetch>(async (input) => {
      const request = requestOf(input);
      requests.push(request);
      const path = new URL(request.url).pathname;
      if (path === '/api/v1/person-merges/41') {
        detailReads += 1;
        if (detailReads === 3)
          return Response.json({ error: 'unavailable', message: 'Detail still unavailable' }, { status: 503 });
        return Response.json(detail({ survivor_revision_after: detailReads === 1 ? 4 : 6 }));
      }
      if (path === '/api/v1/people/12') {
        sourceReads += 1;
        if (sourceReads === 2) return Response.json(person(12, 5, [701, 702], 'Unpublishable Source'));
        if (sourceReads === 3)
          return Response.json({ error: 'unavailable', message: 'Source still unavailable' }, { status: 503 });
        const revision = sourceReads === 1 ? 4 : 6;
        return Response.json(person(12, revision, [701, 702], revision === 4 ? 'Synthetic Source' : 'Fresh Synthetic Source'), {
          headers: { ETag: `"person-12-r${revision}"` },
        });
      }
      if (path.endsWith('/snapshot')) return Response.json({ snapshot: { persons: [{ id: 7, display_name: 'Earlier Example' }] } });
      if (request.method === 'GET') return Response.json({ identifiers: [] });
      postAttempts += 1;
      return postAttempts === 1
        ? Response.json({ error: 'person_merge_revision_conflict', message: 'Source changed' }, { status: 409 })
        : Response.json(splitResult());
    });
    vi.spyOn(requestID, 'createBrowserRequestID')
      .mockReturnValueOnce('123-456-789-12')
      .mockReturnValueOnce('234-567-890-23');
    const controller = new PersonMergeHistoryController(createAPIClient(fetchFn), 7);
    await controller.selectMerge(41);
    expect(controller.labels?.names.get(7)).toBe('Recorded Name');
    await controller.openSplit();
    controller.setParticipantSelected(701, true);
    controller.confirmSplit();

    await controller.submitSplit();

    expect(controller.splitNeedsFreshState).toBe(true);
    expect(controller.sourcePerson?.revision).toBe(4);
    expect(controller.sourceETag).toBe('"person-12-r4"');
    expect(controller.detail?.merge.survivor_revision_after).toBe(4);
    expect(controller.confirmSplit()).toBe(false);
    await controller.submitSplit();
    expect(requests.filter((request) => request.method === 'POST')).toHaveLength(1);

    await expect(controller.retryStaleSplitState()).resolves.toBe(false);

    expect(controller.splitNeedsFreshState).toBe(true);
    expect(controller.sourcePerson?.revision).toBe(4);
    expect(controller.detail?.merge.survivor_revision_after).toBe(4);
    expect(requests.filter((request) => request.method === 'POST')).toHaveLength(1);
    expect(requests.slice(-2).every((request) => request.method === 'GET')).toBe(true);

    await expect(controller.retryStaleSplitState()).resolves.toBe(true);

    expect(controller.splitNeedsFreshState).toBe(false);
    expect(controller.sourcePerson?.display_name).toBe('Fresh Synthetic Source');
    expect(controller.sourcePerson?.revision).toBe(6);
    expect(controller.sourceETag).toBe('"person-12-r6"');
    expect(controller.detail?.merge.survivor_revision_after).toBe(6);
    await vi.waitFor(() => expect(controller.labels?.names.get(7)).toBe('Recorded Name'));
    expect(controller.labels?.for).toBe(controller.detail);
    expect(controller.selectedParticipantIDs).toEqual([]);
    expect(requests.filter((request) => request.method === 'POST')).toHaveLength(1);

    controller.setParticipantSelected(701, true);
    expect(controller.confirmSplit()).toBe(true);
    await controller.submitSplit();

    const posts = requests.filter((request) => request.method === 'POST');
    expect(posts).toHaveLength(2);
    expect(posts[1]!.headers.get('If-Match')).toBe('"person-12-r6"');
    expect(posts[1]!.headers.get('Idempotency-Key')).toBe('234-567-890-23');
  });

  it('keeps recorded names when the live source changes during a stale split reload', async () => {
    let fresh = false, snapshots = 0;
    const controller = new PersonMergeHistoryController(createAPIClient(async input => {
      const request = requestOf(input), path = new URL(request.url).pathname;
      if (request.method === 'POST') { fresh = true; return Response.json({ error: 'person_merge_revision_conflict' }, { status: 409 }); }
      if (path.endsWith('/person-merges/41')) return Response.json(detail({ survivor_revision_after: fresh ? 5 : 4 }));
      if (path.endsWith('/people/12')) return Response.json(person(12, fresh ? 5 : 4, [701, 702], fresh ? 'Fresh Name' : 'Earlier Name'), { headers: { ETag: fresh ? '"person-12-r5"' : '"person-12-r4"' } });
      if (path.endsWith('/snapshot')) { snapshots++; return Response.json({ snapshot: { persons: [{ id: 7, display_name: 'Recorded Name' }] } }); }
      return Response.json({ identifiers: [] });
    }), 7);
    await controller.selectMerge(41);
    await controller.openSplit();
    controller.setParticipantSelected(701, true);
    controller.confirmSplit();
    await controller.submitSplit();
    controller.closeSplit();
    expect(controller.sourcePerson?.display_name).toBe('Fresh Name');
    expect(controller.labels?.names.get(7)).toBe('Recorded Name');
    expect(controller.labels?.for).toBe(controller.detail);
    expect(snapshots).toBe(0);
    controller.destroy();
  });

  it.each([
    [409, 'person_split_idempotency_conflict'],
    [412, 'person_merge_revision_conflict'],
  ])('does not stale-reload for %s/%s and rotates after the application failure', async (status, error) => {
    const requests: Request[] = [];
    const fetchFn = vi.fn<typeof fetch>(async (input) => {
      const request = requestOf(input);
      requests.push(request);
      const path = new URL(request.url).pathname;
      if (path === '/api/v1/person-merges/41') return Response.json(detail());
      if (request.method === 'GET') return Response.json(person(12, 4, [701, 702], 'Synthetic Person 12'), { headers: { ETag: '"person-12-r4"' } });
      return Response.json({ error, message: 'Application failure' }, { status });
    });
    vi.spyOn(requestID, 'createBrowserRequestID')
      .mockReturnValueOnce('123-456-789-12')
      .mockReturnValueOnce('234-567-890-23');
    const controller = new PersonMergeHistoryController(createAPIClient(fetchFn), 7);
    await controller.selectMerge(41);
    await controller.openSplit();
    controller.setParticipantSelected(701, true);
    controller.confirmSplit();
    await controller.submitSplit();
    controller.confirmSplit();
    await controller.submitSplit();

    expect(requests.filter(request => request.method === 'GET' &&
      ['/api/v1/person-merges/41', '/api/v1/people/12'].includes(new URL(request.url).pathname))
      .map(request => new URL(request.url).pathname)).toEqual(['/api/v1/person-merges/41', '/api/v1/people/12']);
    expect(
      requests.filter((request) => request.method === 'POST').map((request) => request.headers.get('Idempotency-Key')),
    ).toEqual(['123-456-789-12', '234-567-890-23']);
  });

  it('commits once, keeps malformed receipt tags out of state, and reports reconciliation separately', async () => {
    const reconcile = vi.fn(async (): Promise<void> => {
      throw new Error('refresh failed');
    });
    const fetchFn = vi.fn<typeof fetch>(async (input) => {
      const request = requestOf(input);
      const path = new URL(request.url).pathname;
      if (path === '/api/v1/person-merges/41') return Response.json(detail());
      if (request.method === 'GET') return Response.json(person(12, 4, [701, 702], 'Synthetic Person 12'), { headers: { ETag: '"person-12-r4"' } });
      return Response.json(splitResult(false), { headers: { ETag: 'bad', 'X-New-Person-ETag': 'also-bad' } });
    });
    const controller = new PersonMergeHistoryController(createAPIClient(fetchFn), 7, reconcile);
    await controller.selectMerge(41);
    await controller.openSplit();
    controller.setParticipantSelected(701, true);
    controller.confirmSplit();

    await controller.submitSplit();
    await controller.submitSplit();

    expect(reconcile).toHaveBeenCalledOnce();
    expect(reconcile).toHaveBeenCalledWith({ sourcePersonID: 12, newPersonID: 19 });
    expect(controller.committedResult?.result.exact_reversal).toBe(false);
    expect(controller.committedResult?.receiptETags).toEqual({ source: null, created: null });
    expect(controller.reconciliationError).toBe('The split is done. Open either profile to load it fresh.');
    expect(controller.canOfferSplit).toBe(false);
    reconcile.mockResolvedValueOnce(undefined);
    await controller.retryReconciliation();
    expect(controller.reconciliationError).toBeNull();
    expect(reconcile).toHaveBeenCalledTimes(2);
    expect(fetchFn.mock.calls.filter(([input]) => requestOf(input).method === 'POST')).toHaveLength(1);
  });

  it('discards a late reconciliation rejection after person context changes', async () => {
    let rejectReconciliation!: (cause: unknown) => void;
    const reconciliation = new Promise<void>((_resolve, reject) => {
      rejectReconciliation = reject;
    });
    const fetchFn = vi.fn<typeof fetch>(async (input) => {
      const request = requestOf(input);
      const path = new URL(request.url).pathname;
      if (path === '/api/v1/person-merges/41') return Response.json(detail());
      if (path === '/api/v1/people/12') return Response.json(person(12, 4, [701, 702], 'Synthetic Person 12'), { headers: { ETag: '"person-12-r4"' } });
      if (request.method === 'POST') return Response.json(splitResult());
      return Response.json({ merges: [], limit: 100, offset: 0 });
    });
    const controller = new PersonMergeHistoryController(createAPIClient(fetchFn), 7, () => reconciliation);
    await controller.selectMerge(41);
    await controller.openSplit();
    controller.setParticipantSelected(701, true);
    controller.confirmSplit();

    const submit = controller.submitSplit();
    await vi.waitFor(() => expect(controller.committedResult).not.toBeNull());
    controller.setPerson(8);
    rejectReconciliation(new Error('late refresh failure'));
    await submit;

    expect(controller.committedResult).toBeNull();
    expect(controller.reconciliationError).toBeNull();
  });

  it('aborts and discards every late effect when person context changes', async () => {
    const late = deferredResponse();
    const requests: Request[] = [];
    const fetchFn = vi.fn<typeof fetch>(async (input) => {
      const request = requestOf(input);
      requests.push(request);
      if (new URL(request.url).pathname === '/api/v1/people/7/merges') return late.promise;
      return Response.json({ merges: [summary(99)], limit: 100, offset: 0 });
    });
    const controller = new PersonMergeHistoryController(createAPIClient(fetchFn), 7);
    const first = controller.loadHistory();
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    controller.setPerson(8);
    await vi.waitFor(() => expect(requests).toHaveLength(2));
    late.resolve(Response.json({ merges: [summary(41)], limit: 100, offset: 0 }));
    await first;

    expect(requests[0]!.signal.aborted).toBe(true);
    expect(controller.personID).toBe(8);
    expect(controller.history[0]?.merge.id).toBe(99);
    expect(controller.snapshot).toBeNull();
  });

  it('discards late detail, snapshot, and committed split effects after their context is replaced', async () => {
    const lateDetail = deferredResponse();
    const lateSnapshot = deferredResponse();
    const lateSplit = deferredResponse();
    const requests: Request[] = [];
    let detailReads = 0;
    let snapshotReads = 0;
    const fetchFn = vi.fn<typeof fetch>(async (input) => {
      const request = requestOf(input);
      requests.push(request);
      const path = new URL(request.url).pathname;
      if (path === '/api/v1/person-merges/41') {
        detailReads += 1;
        return detailReads === 1 ? Response.json(detail()) : lateDetail.promise;
      }
      if (path.endsWith('/snapshot')) return ++snapshotReads === 1 ? Response.json({}, { status: 503 }) : lateSnapshot.promise;
      if (request.method === 'POST') return lateSplit.promise;
      if (path === '/api/v1/people/12') return Response.json(person(12, 4, [701, 702], 'Synthetic Person 12'), { headers: { ETag: '"person-12-r4"' } });
      if (path === '/api/v1/people/7') return Response.json(person(7));
      if (path.startsWith('/api/v1/participants/')) return Response.json({ identifiers: [] });
      if (path.endsWith('/merges')) return Response.json({ merges: [], limit: 100, offset: 0 });
      throw new Error(`Unexpected request: ${path}`);
    });
    const controller = new PersonMergeHistoryController(createAPIClient(fetchFn), 7);
    await controller.selectMerge(41);
    await controller.openSplit();
    controller.setParticipantSelected(701, true);
    controller.confirmSplit();

    await controller.revealSnapshot();
    const snapshotRead = controller.revealSnapshot();
    const splitWrite = controller.submitSplit();
    const detailRead = controller.selectMerge(41);
    await vi.waitFor(() => {
      expect(requests.filter(request => new URL(request.url).pathname === '/api/v1/person-merges/41')).toHaveLength(2);
      expect(requests.filter(request => new URL(request.url).pathname.endsWith('/snapshot'))).toHaveLength(2);
      expect(requests.filter(request => request.method === 'POST')).toHaveLength(1);
    });
    controller.setPerson(8);

    lateDetail.resolve(Response.json(detail({ current_person_id: 99 })));
    lateSnapshot.resolve(Response.json({ version: 1, sha256: 'late', snapshot: { late: true } }));
    lateSplit.resolve(Response.json(splitResult()));
    await Promise.all([detailRead, snapshotRead, splitWrite]);

    const lateRequests = [
      requests.filter(request => new URL(request.url).pathname === '/api/v1/person-merges/41')[1]!,
      requests.filter(request => new URL(request.url).pathname.endsWith('/snapshot'))[1]!,
      requests.find(request => request.method === 'POST')!,
    ];
    expect(lateRequests.every((request) => request.signal.aborted)).toBe(true);
    expect(controller.personID).toBe(8);
    expect(controller.detail).toBeNull();
    expect(controller.snapshot).toBeNull();
    expect(controller.committedResult).toBeNull();
  });
});


it('uses detail labels before the list loads and keeps snapshot failure inside its disclosure', async () => {
  const paths: string[] = [];
  const labels = {
    profiles: [{ id: 7, display_name: 'Survivor', participant_ids: [702] }, { id: 9, display_name: 'Absorbed', participant_ids: [701] }],
    participants: detail().participants,
    members: [{ participant_id: 701, email: 'earlier@example.org', normalized_value: 'earlier@example.org' }, { participant_id: 702, email: 'current@example.org', normalized_value: 'current@example.org' }],
    identifiers: [], incomplete: false,
  };
  const controller = new PersonMergeHistoryController(createAPIClient(async input => {
    const path = new URL(requestOf(input).url).pathname;
    paths.push(path);
    if (path === '/api/v1/person-merges/41') return Response.json({ ...detail(), labels });
    if (path.endsWith('/snapshot')) return Response.json({}, { status: 503 });
    return Response.json({ identifiers: [] });
  }), 12);
  await controller.selectMerge(41);
  expect(paths).toEqual(['/api/v1/person-merges/41']);
  expect(controller.labels?.names.get(9)).toBe('Absorbed');
  expect(controller.labels?.addresses.get(701)?.[0].title).toBe('earlier@example.org');
  expect(controller.labels?.incomplete).toBe(false);
  await controller.revealSnapshot();
  expect(controller.snapshotError).toBe('The server answered 503.');
  expect(controller.labels?.incomplete).toBe(false);
  controller.destroy();
});
