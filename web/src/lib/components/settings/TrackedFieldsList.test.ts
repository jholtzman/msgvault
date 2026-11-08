import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
import { createAPIClient } from '../../api/client';
import TrackedFieldsList from './TrackedFieldsList.svelte';

describe('Fields kept updated', () => {
  it.each(['http', 'network'])('retries field catalog failures in place: %s', async failure => {
    const queries: string[] = [];
    const client = createAPIClient(async input => {
      const url = new URL((input as Request).url);
      if (url.pathname.endsWith('/attribute-definitions')) return Response.json({ definitions: [{ slug: 'favorite_plant', label: 'Preferred greenery' }, { slug: 'private_note', label: 'Private note' }] });
      queries.push(url.search);
      if (queries.length === 1 && failure === 'network') throw new TypeError('Failed to fetch');
      if (queries.length === 2 && failure === 'http') return Response.json({ message: 'Synthetic lookup unavailable' }, { status: 503 });
      if (failure === 'network') return Response.json({ targets: [] });
      return Response.json({ targets: [
        { kind: 'attribute', key: 'field:favorite_plant', slug: 'favorite_plant', description: 'A plant', sensitive: false },
        { kind: 'employment', key: 'system:employment', slug: 'employment', description: 'Current and historical employment', sensitive: false },
        ...(url.searchParams.get('include_sensitive') === 'true' ? [{ kind: 'attribute', key: 'field:private_note', slug: 'private_note', description: 'A note', sensitive: true }] : []),
      ] });
    });
    render(TrackedFieldsList, { client });
    expect(await screen.findByRole('heading', { name: 'Fields kept updated' })).toBeDefined();
    if (failure === 'network') {
      const error = await screen.findByText("Couldn't load the fields kept updated.");
      expect(error.closest('details')).toBeNull();
      await fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
      expect(await screen.findByText('No fields yet')).toBeDefined();
      expect(queries).toEqual(['?include_sensitive=false', '?include_sensitive=false']);
      return;
    }
    expect(await screen.findByText('Preferred greenery')).toBeDefined();
    expect(screen.getByText('Work · job title, organization, and dates')).toBeDefined();
    expect(queries).toEqual(['?include_sensitive=false']);
    const disclosure = screen.getByText('Show sensitive fields');
    await fireEvent.click(disclosure);
    const error = await screen.findByText("Couldn't load sensitive fields.");
    expect(error.closest('details')?.open).toBe(true);
    await fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    // The fold says they're sensitive, so the rows don't.
    const sensitive = await screen.findByText('Private note');
    expect(sensitive.closest('details')?.open).toBe(true);
    expect(queries).toEqual(['?include_sensitive=false', '?include_sensitive=true', '?include_sensitive=true']);
    await fireEvent.click(disclosure);
    await waitFor(() => expect(sensitive.closest('details')?.open).toBe(false));
  });

  it('keeps loaded fields and retries unavailable field names', async () => {
    let names = 0, targets = 0;
    const client = createAPIClient(async input => {
      const url = new URL((input as Request).url);
      if (url.pathname.endsWith('/attribute-definitions')) {
        if (++names === 1) return Response.json({ message: 'Synthetic names unavailable' }, { status: 503 });
        return Response.json({ definitions: [{ slug: 'rr_27', label: 'Preferred greenery' }] });
      }
      targets++;
      return Response.json({ targets: [{ kind: 'attribute', key: 'field:rr_27', slug: 'rr_27', description: 'A plant', sensitive: false }] });
    });
    render(TrackedFieldsList, { client });
    expect(await screen.findByText('Rr 27')).toBeDefined();
    await fireEvent.click(await screen.findByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Preferred greenery')).toBeDefined();
    expect(targets).toBe(1);
    expect(names).toBe(2);
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
});
