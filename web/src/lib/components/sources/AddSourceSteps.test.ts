import { fireEvent, render, screen } from '@testing-library/svelte';
import { expect, it } from 'vitest';
import AddSourceSteps from './AddSourceSteps.svelte';
import { ADD_SOURCE_KINDS, type CommandSourceKind } from '../../sources/add-source';

it('shows the IMAP password prompt and separate shell commands', async () => {
  render(AddSourceSteps, { kind: ADD_SOURCE_KINDS.find(kind => kind.id === 'imap') as CommandSourceKind });
  const dialog = screen;
  expect(dialog.getByText('The command asks for your password.')).toBeDefined();
  await fireEvent.input(dialog.getByLabelText('Server'), { target: { value: 'imap.example.com' } });
  await fireEvent.input(dialog.getByLabelText('Username'), { target: { value: '~/reader' } });
  expect(dialog.getByText('The command asks for your password.')).toBeDefined();
  expect(dialog.getByRole('button', { name: /^Copy / }).textContent?.trim()).toBe('Copy');
  expect(dialog.getAllByRole('listitem').map(item => item.textContent)).toEqual(['Run this command in a terminal where msgvault is installed.', 'Run the first-sync command it prints.', 'Press Done.']);
  expect(dialog.getByRole('link', { name: 'Setup guide' })).toBeDefined();
  const posix = dialog.getByRole('button', { name: /^Copy / }).getAttribute('aria-label');
  await fireEvent.click(dialog.getByRole('radio', { name: 'Windows' }));
  expect(dialog.getByText(/Start Command Prompt with/)).toBeDefined();
  const copies = dialog.getAllByRole('button', { name: /^Copy / });
  expect(copies).toHaveLength(1);
  expect(copies[0].getAttribute('aria-label')).not.toBe(posix);
});
