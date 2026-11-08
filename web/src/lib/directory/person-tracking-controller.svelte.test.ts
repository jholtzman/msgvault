import { requestOf } from './entity-fixtures.test-support';
import { describe, expect, it, vi } from 'vitest';

import { createAPIClient } from '../api/client';
import { PersonTrackingController } from './person-tracking-controller.svelte';

function catalog(includeSensitive = false) {
  return {
    version: 'v1',
    fingerprint: 'forbidden-catalog-fingerprint',
    targets: [{
      kind: 'attribute',
      key: includeSensitive ? 'field:private_note' : 'field:time_zone',
      revision: `sha256:${'a'.repeat(64)}`,
      slug: includeSensitive ? 'private_note' : 'time_zone',
      universal_id: 'forbidden-universal-id',
      description: includeSensitive ? 'Private note' : 'Time zone',
      value_type: 'text',
      cardinality: 'single',
      sensitive: includeSensitive,
      choices: null,
      fields: null
    }]
  };
}

function deferredResponse() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((settle) => { resolve = settle; });
  return { promise, resolve };
}

describe('PersonTrackingController', () => {
  it.each([{ slug: 12 }, { key: 12 }])('rejects a malformed catalog identity: %j', async malformed => {
    const client = createAPIClient(vi.fn<typeof fetch>(async (input) => {
      if (new URL(requestOf(input).url).pathname.endsWith('/tracking')) return Response.json({ person_id: 7, tracked: false, tracked_at: null });
      return Response.json({ targets: [{ ...catalog().targets[0], ...malformed }] });
    }));
    const controller = new PersonTrackingController(client);
    await controller.setPerson(7);
    await controller.retryCatalog(false);
    expect(controller.targets).toEqual([]);
    expect(controller.catalogError).toBe("The server's list of fields couldn't be read.");
    controller.destroy();
  });

  it('loads the exact durable-person state and non-sensitive catalog and projects safe fields', async () => {
    const requests: Array<{ method: string; path: string; includeSensitive: string | null }> = [];
    const fetchFn = vi.fn<typeof fetch>(async (input) => {
      const request = requestOf(input);
      const url = new URL(request.url);
      requests.push({
        method: request.method,
        path: url.pathname,
        includeSensitive: url.searchParams.get('include_sensitive')
      });
      if (url.pathname === '/api/v1/people/7/tracking') {
        return Response.json({ person_id: 7, tracked: true, tracked_at: null });
      }
      if (url.pathname === '/api/v1/person-fact-targets') return Response.json(catalog());
      throw new Error(`Unexpected ${request.method} ${url.pathname}`);
    });
    const controller = new PersonTrackingController(createAPIClient(fetchFn));

    await controller.setPerson(7);
    await controller.retryCatalog(false);

    expect(requests).toEqual([
      { method: 'GET', path: '/api/v1/people/7/tracking', includeSensitive: null },
      { method: 'GET', path: '/api/v1/person-fact-targets', includeSensitive: 'false' }
    ]);
    expect(requests.some(({ path }) => path.includes('/participants/'))).toBe(false);
    expect(controller.tracking).toEqual({ person_id: 7, tracked: true, tracked_at: null });
    expect(controller.targets).toEqual([{
      key: 'field:time_zone', kind: 'attribute', slug: 'time_zone', description: 'Time zone', sensitive: false
    }]);
    expect(JSON.stringify(controller.targets)).not.toMatch(/fingerprint|universal|forbidden/i);
    controller.destroy();
  });

  it('keeps the person-independent catalog while replacing and aborting tracking contexts', async () => {
    const lateTracking = deferredResponse();
    const lateCatalog = deferredResponse();
    const requests: Request[] = [];
    const controller = new PersonTrackingController(createAPIClient(async input => {
      const request = requestOf(input);
      requests.push(request);
      const path = new URL(request.url).pathname;
      if (path.endsWith('/person-fact-targets')) return lateCatalog.promise;
      if (path.endsWith('/7/tracking')) return lateTracking.promise;
      return Response.json({ person_id: 9, tracked: false, tracked_at: null });
    }));
    const catalogRead = controller.retryCatalog(false);
    const first = controller.setPerson(7);
    await controller.setPerson(9);
    expect(requests[0]!.signal.aborted).toBe(false);
    expect(requests[1]!.signal.aborted).toBe(true);
    lateCatalog.resolve(Response.json(catalog()));
    lateTracking.resolve(Response.json({ person_id: 7, tracked: true, tracked_at: null }));
    await Promise.all([catalogRead, first]);
    expect(controller.personID).toBe(9);
    expect(controller.tracking?.tracked).toBe(false);
    expect(controller.targets).toEqual([{ key: 'field:time_zone', kind: 'attribute', slug: 'time_zone', description: 'Time zone', sensitive: false }]);
    expect(requests.filter(request => new URL(request.url).pathname.endsWith('/person-fact-targets'))).toHaveLength(1);
    controller.destroy();
  });

  it('sends one exact replacement body, suppresses duplicates, and commits only matching success', async () => {
    const mutation = deferredResponse();
    const facts: Array<{ method: string; path: string; tracked?: boolean; headerNames: string[] }> = [];
    const fetchFn = vi.fn<typeof fetch>(async (input) => {
      const request = requestOf(input);
      const path = new URL(request.url).pathname;
      const body = request.method === 'PUT' ? await request.clone().json() as { tracked?: unknown } : undefined;
      facts.push({
        method: request.method,
        path,
        ...(typeof body?.tracked === 'boolean' ? { tracked: body.tracked } : {}),
        headerNames: [...request.headers.keys()].filter((name) => name !== 'content-type')
      });
      if (request.method === 'PUT') return mutation.promise;
      if (path.endsWith('/tracking')) return Response.json({ person_id: 7, tracked: false, tracked_at: null });
      return Response.json(catalog());
    });
    const controller = new PersonTrackingController(createAPIClient(fetchFn));
    await controller.setPerson(7);

    const first = controller.setTracked(true);
    expect(controller.pending).toBe(true);
    expect(await controller.setTracked(false)).toEqual({ kind: 'ignored' });
    mutation.resolve(Response.json({ person_id: 7, tracked: true, tracked_at: '2026-08-29T00:00:00Z' }));

    expect(await first).toEqual({ kind: 'confirmed', desired: true });
    expect(controller.tracking?.tracked).toBe(true);
    expect(controller.announcement).toBe('Keeping this profile updated.');
    expect(facts.filter(({ method }) => method === 'PUT')).toEqual([{
      method: 'PUT', path: '/api/v1/people/7/tracking', tracked: true, headerNames: []
    }]);
    controller.destroy();
  });

  it('retains confirmed state for known mutation failures without reconciliation or replay', async () => {
    let gets = 0;
    let puts = 0;
    const fetchFn = vi.fn<typeof fetch>(async (input) => {
      const request = requestOf(input);
      const path = new URL(request.url).pathname;
      if (request.method === 'PUT') {
        puts += 1;
        return Response.json({ error: 'not_found', message: 'forbidden private error' }, { status: 404 });
      }
      if (path.endsWith('/tracking')) {
        gets += 1;
        return Response.json({ person_id: 7, tracked: false, tracked_at: null });
      }
      return Response.json(catalog());
    });
    const controller = new PersonTrackingController(createAPIClient(fetchFn));
    await controller.setPerson(7);

    expect(await controller.setTracked(true)).toEqual({ kind: 'error', desired: true });
    expect(controller.tracking?.tracked).toBe(false);
    expect(controller.trackingError).toBe("Couldn't save.");
    expect(JSON.stringify(controller)).not.toContain('forbidden private error');
    expect([puts, gets]).toEqual([1, 1]);
    controller.destroy();
  });

  it.each(['transport', 'server', 'mismatched'] as const)(
    'reconciles an ambiguous %s result with one GET and never replays the PUT',
    async (failure) => {
      let gets = 0;
      let puts = 0;
      const fetchFn = vi.fn<typeof fetch>(async (input) => {
        const request = requestOf(input);
        const path = new URL(request.url).pathname;
        if (request.method === 'PUT') {
          puts += 1;
          if (failure === 'transport') throw new TypeError('synthetic transport failure');
          if (failure === 'server') return Response.json({ error: 'unavailable' }, { status: 503 });
          return Response.json({ person_id: 9, tracked: true, tracked_at: '2026-08-29T00:00:00Z' });
        }
        if (path.endsWith('/tracking')) {
          gets += 1;
          return Response.json({
            person_id: 7,
            tracked: gets > 1,
            tracked_at: gets > 1 ? '2026-08-29T00:00:00Z' : null
          });
        }
        return Response.json(catalog());
      });
      const controller = new PersonTrackingController(createAPIClient(fetchFn));
      await controller.setPerson(7);

      expect(await controller.setTracked(true)).toEqual({ kind: 'reconciled', desired: true });
      expect([puts, gets]).toEqual([1, 2]);
      expect(controller.tracking?.tracked).toBe(true);
      expect(controller.stateUnknown).toBe(false);
      expect(controller.announcement).toBe('Keeping this profile updated.');
      controller.destroy();
    }
  );

  it('says a save failed when the read-back shows the switch where it was, and Retry saves it again', async () => {
    let gets = 0;
    let puts = 0;
    const fetchFn = vi.fn<typeof fetch>(async (input) => {
      const request = requestOf(input);
      const path = new URL(request.url).pathname;
      if (request.method === 'PUT') {
        puts += 1;
        if (puts === 1) throw new TypeError('synthetic transport failure');
        return Response.json({ person_id: 7, tracked: true, tracked_at: '2026-08-29T00:00:00Z' });
      }
      if (path.endsWith('/tracking')) {
        gets += 1;
        return Response.json({ person_id: 7, tracked: false, tracked_at: null });
      }
      return Response.json(catalog());
    });
    const controller = new PersonTrackingController(createAPIClient(fetchFn));
    await controller.setPerson(7);

    expect(await controller.setTracked(true)).toEqual({ kind: 'error', desired: true });
    expect([puts, gets]).toEqual([1, 2]);
    expect(controller.failedSave).toBe(true);
    expect(controller.stateUnknown).toBe(false);
    expect(controller.trackingError).toBe("Couldn't save.");

    expect(await controller.retrySave()).toEqual({ kind: 'confirmed', desired: true });
    expect([puts, gets]).toEqual([2, 2]);
    expect(controller.failedSave).toBeNull();
    expect(controller.trackingError).toBeNull();
    expect(controller.tracking?.tracked).toBe(true);
    controller.destroy();
  });

  it('locks mutation after failed reconciliation and recovers through GET-only retry', async () => {
    let gets = 0;
    let puts = 0;
    const fetchFn = vi.fn<typeof fetch>(async (input) => {
      const request = requestOf(input);
      const path = new URL(request.url).pathname;
      if (request.method === 'PUT') {
        puts += 1;
        throw new TypeError('synthetic transport failure');
      }
      if (path.endsWith('/tracking')) {
        gets += 1;
        if (gets === 2) return Response.json({ error: 'unavailable' }, { status: 503 });
        return Response.json({ person_id: 7, tracked: gets > 2, tracked_at: gets > 2 ? '2026-08-29T00:00:00Z' : null });
      }
      return Response.json(catalog());
    });
    const controller = new PersonTrackingController(createAPIClient(fetchFn));
    await controller.setPerson(7);

    expect(await controller.setTracked(true)).toEqual({ kind: 'unknown', desired: true });
    expect(controller.stateUnknown).toBe(true);
    expect(controller.tracking).toBeUndefined();
    expect(await controller.setTracked(true)).toEqual({ kind: 'ignored' });
    await controller.retryTracking();

    expect([puts, gets]).toEqual([1, 3]);
    expect(controller.tracking?.tracked).toBe(true);
    expect(controller.stateUnknown).toBe(false);
    controller.destroy();
  });

  it('invalidates confirmed tracking after a failed refresh and blocks mutation', async () => {
    let trackingReads = 0;
    let puts = 0;
    const fetchFn = vi.fn<typeof fetch>(async (input) => {
      const request = requestOf(input);
      const path = new URL(request.url).pathname;
      if (request.method === 'PUT') {
        puts += 1;
        return Response.json({ person_id: 7, tracked: true, tracked_at: null });
      }
      if (path.endsWith('/tracking')) {
        trackingReads += 1;
        if (trackingReads === 1) return Response.json({ person_id: 7, tracked: false, tracked_at: null });
        return Response.json({ error: 'unavailable' }, { status: 503 });
      }
      return Response.json(catalog());
    });
    const controller = new PersonTrackingController(createAPIClient(fetchFn));
    await controller.setPerson(7);

    await controller.retryTracking();

    expect(controller.stateUnknown).toBe(true);
    expect(await controller.setTracked(true)).toEqual({ kind: 'ignored' });
    expect(puts).toBe(0);
    controller.destroy();
  });

  it('keeps catalog and tracking failures independent and reveals sensitive definitions only explicitly', async () => {
    let catalogCalls = 0;
    let trackingCalls = 0;
    const queries: string[] = [];
    const fetchFn = vi.fn<typeof fetch>(async (input) => {
      const request = requestOf(input);
      const url = new URL(request.url);
      if (url.pathname.endsWith('/tracking')) {
        trackingCalls += 1;
        if (trackingCalls === 1) return Response.json({ error: 'unavailable' }, { status: 503 });
        return Response.json({ person_id: 7, tracked: false, tracked_at: null });
      }
      catalogCalls += 1;
      queries.push(url.search);
      if (catalogCalls === 2) return Response.json({ error: 'unavailable' }, { status: 503 });
      return Response.json(catalog(catalogCalls > 2));
    });
    const controller = new PersonTrackingController(createAPIClient(fetchFn));
    await controller.setPerson(7);
    await controller.retryCatalog(false);

    expect(controller.tracking).toBeUndefined();
    expect(controller.trackingError).toBe("Couldn't check this profile's updates.");
    expect(controller.targets[0]?.slug).toBe('time_zone');
    await controller.retryTracking();
    expect(controller.tracking?.tracked).toBe(false);
    await controller.retryCatalog(true);
    expect(controller.targets[0]?.slug).toBe('time_zone');
    expect(controller.catalogError).toBe('The server answered 503.');
    expect(controller.catalogIncludesSensitive).toBe(false);
    await controller.retryCatalog(true);
    expect(controller.targets[0]?.slug).toBe('private_note');
    expect(controller.catalogIncludesSensitive).toBe(true);
    expect(queries).toEqual(['?include_sensitive=false', '?include_sensitive=true', '?include_sensitive=true']);
    controller.destroy();
  });

  it('aborts pending work on destroy and blocks late state and announcements', async () => {
    const mutation = deferredResponse();
    const signals: AbortSignal[] = [];
    const fetchFn = vi.fn<typeof fetch>(async (input) => {
      const request = requestOf(input);
      signals.push(request.signal);
      const path = new URL(request.url).pathname;
      if (request.method === 'PUT') return mutation.promise;
      if (path.endsWith('/tracking')) return Response.json({ person_id: 7, tracked: false, tracked_at: null });
      return Response.json(catalog());
    });
    const controller = new PersonTrackingController(createAPIClient(fetchFn));
    await controller.setPerson(7);
    const pending = controller.setTracked(true);

    controller.destroy();
    expect(signals.at(-1)?.aborted).toBe(true);
    mutation.resolve(Response.json({ person_id: 7, tracked: true, tracked_at: '2026-08-29T00:00:00Z' }));
    expect(await pending).toEqual({ kind: 'ignored' });
    expect(controller.tracking?.tracked).toBe(false);
    expect(controller.announcement).toBeNull();
  });
});
