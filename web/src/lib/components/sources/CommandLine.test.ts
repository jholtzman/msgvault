import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { expect, it, vi } from 'vitest';
import CommandLine from './CommandLine.svelte';

it('clears copy feedback when the command changes', async () => {
  const writeText = vi.fn(async () => undefined);
  const originalClipboard = navigator.clipboard;
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  try {
    const view = render(CommandLine, { command: 'msgvault add-account one@example.com' });
    const dialog = screen;
    await fireEvent.click(dialog.getByRole('button', { name: 'Copy msgvault add-account one@example.com' }));
    await waitFor(() => expect(dialog.getByRole('button', { name: 'Copied' }).textContent?.trim()).toBe('Copied'));
    expect(writeText).toHaveBeenCalledWith('msgvault add-account one@example.com');
    await view.rerender({ command: 'msgvault add-account two@example.com' });
    expect(dialog.getByRole('button', { name: 'Copy msgvault add-account two@example.com' })).toBeDefined();
    await fireEvent.click(dialog.getByRole('button', { name: 'Copy msgvault add-account two@example.com' }));
    await waitFor(() => expect(writeText).toHaveBeenLastCalledWith('msgvault add-account two@example.com'));
  } finally {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: originalClipboard });
  }
});
