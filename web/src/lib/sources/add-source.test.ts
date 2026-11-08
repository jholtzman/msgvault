import { describe, expect, it } from 'vitest';
import { ADD_SOURCE_KINDS, addSourceCommand, type CommandSourceKind } from './add-source';

function commandKind(id: string): CommandSourceKind {
  const kind = ADD_SOURCE_KINDS.find(kind => kind.id === id);
  if (!kind || !('fields' in kind)) throw new Error(`Missing command source kind: ${id}`);
  return kind;
}

const gmail = commandKind('gmail');
const imap = commandKind('imap');

describe('addSourceCommand', () => {
  it('trims Gmail values and requires every IMAP field', () => {
    expect(addSourceCommand(gmail, { email: ' user@example.org ' }, 'posix')).toBe('msgvault add-account user@example.org');
    expect(addSourceCommand(gmail, { email: '  ' }, 'posix')).toBeUndefined();
    expect(addSourceCommand(imap, { host: 'imap.example.com' }, 'posix')).toBeUndefined();
  });

  it('quotes spaces and shell characters for each platform', () => {
    expect(addSourceCommand(imap, { host: 'imap.example.org', username: 'A B' }, 'posix')).toBe("msgvault add-imap --host imap.example.org --username 'A B'");
    expect(addSourceCommand(imap, { host: 'imap.example.org', username: 'A B' }, 'cmd')).toBe('msgvault add-imap --host imap.example.org --username "A B"');
    expect(addSourceCommand(imap, { host: 'imap.example.com', username: '~/reader' }, 'posix')).toBe("msgvault add-imap --host imap.example.com --username '~/reader'");
    expect(addSourceCommand(commandKind('microsoft'), { email: 'user@example.org' }, 'cmd')).toBe('msgvault add-o365 user@example.org');
  });
});

it.each(['posix', 'cmd'] as const)('keeps a leading hyphen in the email argument on %s', shell => {
  expect(addSourceCommand(gmail, { email: '-sender@example.org' }, shell)).toBe('msgvault add-account -- -sender@example.org');
  expect(addSourceCommand(commandKind('microsoft'), { email: '--force' }, shell)).toBe('msgvault add-o365 -- --force');
});
