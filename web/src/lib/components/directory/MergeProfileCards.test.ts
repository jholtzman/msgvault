import { render, screen, within } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
import MergeProfileCards from './MergeProfileCards.svelte';

describe('MergeProfileCards', () => {
  it('shows each address once when either heading names that address', () => {
    render(MergeProfileCards, {
      label: 'Merged profiles',
      from: { title: 'mira.work@example.org', addresses: [{ id: '1', value: 'mira.work@example.org' }] },
      to: { title: 'Slack · neri · workspace: garden-club', addresses: [{ id: '2', value: 'Slack', detail: 'neri · workspace: garden-club' }] },
    });
    const cards = within(screen.getByRole('group', { name: 'Merged profiles' })).getAllByRole('region');
    for (const card of cards) {
      expect(card.textContent?.trim()).toBe(within(card).getByRole('heading').textContent);
    }
  });

  it('keeps an empty line when the profile has no addresses', () => {
    render(MergeProfileCards, { label: 'Merged profiles', from: { title: 'Mira Vale', addresses: [] }, to: { title: 'Neri Bloom', addresses: [] } });
    expect(screen.getAllByText('No addresses')).toHaveLength(2);
  });
});
