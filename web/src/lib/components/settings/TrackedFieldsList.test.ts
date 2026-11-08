import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import { createAPIClient } from '../../api/client';
import TrackedFieldsList from './TrackedFieldsList.svelte';

describe('Fields kept updated', () => {
  it('loads readable fields once and reveals sensitive fields on demand', async () => {
    const queries: string[] = [];
    let names = 0;
    const client = createAPIClient(async input => {
      const url = new URL((input as Request).url);
      if (url.pathname.endsWith('/attribute-definitions')) return ++names === 1 ? Response.json({}, { status: 503 }) : Response.json({ definitions: [{ slug: 'favorite_plant', label: 'Preferred greenery' }, { slug: 'private_note', label: 'Private note' }] });
      queries.push(url.search);
      return Response.json({ targets: [
        { kind: 'attribute', key: 'field:favorite_plant', slug: 'favorite_plant', description: 'A plant', sensitive: false },
        { kind: 'employment', key: 'system:employment', slug: 'employment', description: 'Current and historical employment', sensitive: false },
        ...(url.searchParams.get('include_sensitive') === 'true' ? [{ kind: 'attribute', key: 'field:private_note', slug: 'private_note', description: 'A note', sensitive: true }] : []),
      ] });
    });
    render(TrackedFieldsList, { client });
    expect(await screen.findByRole('heading', { name: 'Fields kept updated' })).toBeDefined();
    expect(await screen.findByText('Favorite plant')).toBeDefined();
    expect(await screen.findByText("Couldn't load field names.")).toBeDefined();
    await fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(names).toBe(2);
    expect(await screen.findByText('Preferred greenery')).toBeDefined();
    expect(screen.getByText('Work · job title, organization, and dates')).toBeDefined();
    expect(queries).toEqual(['?include_sensitive=false']);
    const disclosure = screen.getByText('Show sensitive fields');
    await fireEvent.click(disclosure);
    // The fold says they're sensitive, so the rows don't.
    const sensitive = await screen.findByText('Private note');
    expect(sensitive.closest('details')?.open).toBe(true);
    expect(queries).toEqual(['?include_sensitive=false', '?include_sensitive=true']);
    await fireEvent.click(disclosure);
    await waitFor(() => expect(sensitive.closest('details')?.open).toBe(false));
  });

  it.each([false, true])('lists Work and a custom Employment field, sensitive=%s', async sensitive => {
    const client = createAPIClient(async input => {
      const url = new URL((input as Request).url);
      if (url.pathname.endsWith('/attribute-definitions')) return Response.json({ definitions: [{ slug: 'employment', label: 'Employment' }] });
      return Response.json({ targets: [
        { key: 'system:employment', kind: 'employment', slug: 'employment', description: 'Work', sensitive: false },
        ...(!sensitive || url.searchParams.get('include_sensitive') === 'true' ? [{ key: 'field:employment', kind: 'attribute', slug: 'employment', description: 'Custom employment', sensitive }] : []),
      ] });
    });
    render(TrackedFieldsList, { client });
    expect(await screen.findByText('Work · job title, organization, and dates')).toBeDefined();
    if (sensitive) await fireEvent.click(screen.getByText('Show sensitive fields'));
    expect(await screen.findByText('Employment')).toBeDefined();
    expect(screen.getByText('Employment').closest('details') !== null).toBe(sensitive);
  });

  it('retries a failed lookup in place', async () => {
    let attempts = 0;
    const client = createAPIClient(vi.fn(async input => {
      if ((input as Request).url.includes('attribute-definitions')) return Response.json({ definitions: [] });
      if (++attempts === 1) throw new TypeError('Failed to fetch');
      return Response.json({ targets: [] });
    }));
    render(TrackedFieldsList, { client });
    expect(await screen.findByText("Couldn't load the fields kept updated.")).toBeDefined();
    await fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('No fields yet')).toBeDefined();
  });
});
