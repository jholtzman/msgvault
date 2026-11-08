import { describe, expect, it } from 'vitest';
import type { PersonMergeDetail } from '../api/generated/models';
import { mergeSummaryRow, mergeAddresses, mergeSentence } from './merge-labels';

const detail = {
  rows: [], review_candidates: [],
  merge: { id: 41, survivor_person_id: 7 } as PersonMergeDetail['merge'],
  participants: [701, 702, 703, 704].map(participant_id => ({ merge_id: 41, participant_id, origin_side: participant_id === 704 ? 'survivor' : 'absorbed' })),
  splits: [{ new_person_id: 19 } as NonNullable<PersonMergeDetail['splits']>[number]],
};

describe('mergeSentence', () => {
  it('names both profiles, and a same-name absorbed profile by its first address', () => {
    expect(mergeSentence('Neri Bloom', 'Mira Vale', 'neri@example.org')).toBe('Neri Bloom merged into Mira Vale');
    expect(mergeSentence('Mira Vale · work', 'Mira Vale', 'mira.work@example.org')).toBe('mira.work@example.org merged into Mira Vale');
    expect(mergeSentence('mira', 'Mira Vale', 'mira@example.org')).toBe('mira@example.org merged into Mira Vale');
    expect(mergeSentence('Mira Vale · work', 'Mira Vale')).toBe('Mira Vale · work merged into Mira Vale');
    expect(mergeSentence(undefined, 'Mira Vale', 'mira.work@example.org')).toBe('mira.work@example.org merged into Mira Vale');
    expect(mergeSentence(undefined, undefined)).toBe('Merged-in profile merged into this profile');
  });
});

describe('mergeAddresses', () => {
  it('lists one side’s addresses with the split that took each', () => {
    const value = { ...detail, participants: [
      { merge_id: 41, participant_id: 701, origin_side: 'absorbed', split_id: 55 },
      { merge_id: 41, participant_id: 702, origin_side: 'survivor' },
      { merge_id: 41, participant_id: 703, origin_side: 'absorbed' },
    ] };
    const addresses = new Map([[701, [{ title: 'a@example.org', detail: '' }, { title: '+1202', detail: 'work' }]]]);
    expect(mergeAddresses(value, { addresses }, 'absorbed')).toEqual([
      { title: 'a@example.org', id: '701-0', participantID: 701, value: 'a@example.org', detail: undefined, splitID: 55 },
      { title: '+1202', id: '701-1', participantID: 701, value: '+1202', detail: 'work', splitID: 55 },
      { title: 'Unknown address', id: '703-0', participantID: 703, value: 'Unknown address', detail: undefined, splitID: undefined },
    ]);
  });
});


it('projects recorded names and distinguishes an empty address from a failed identity read', () => {
  const row = mergeSummaryRow({ merge: { ...detail.merge, absorbed_person_id: 9, created_at: '2026-01-03T12:00:00Z' }, labels: {
    profiles: [{ id: 7, display_name: 'Mira Vale', participant_ids: [704] }, { id: 9, display_name: 'Neri Bloom', participant_ids: [701, 702, 703] }],
    participants: detail.participants,
    members: [{ participant_id: 701, display_name: 'Named Sender', email: 'sender@example.org', normalized_value: 'sender@example.org' }, { participant_id: 702, display_name: 'No stored address' }, { participant_id: 704, email: 'primary@example.org', normalized_value: 'primary@example.org' }, { participant_id: 705, phone: '+12025550101', normalized_value: '+12025550101' }],
    identifiers: [{ participant_id: 705, type: 'phone', value: '+12025550101', normalized_value: '+12025550101', display_value: '+1 202 555 0101', service_slug: 'phone', service_label: 'Phone', scope_kind: '', scope_value: '' }, { participant_id: 704, type: 'handle', value: 'neri', display_value: '', normalized_value: 'neri', service_slug: 'slack', service_label: 'Slack', scope_kind: 'workspace', scope_value: 'garden-club' }, { participant_id: 704, type: 'email', value: 'explicit@example.org', display_value: '', normalized_value: 'explicit@example.org', service_slug: 'email', service_label: 'Email', scope_kind: '', scope_value: '' }], incomplete: false,
  } });
  expect(row.names.get(9)).toBe('Neri Bloom');
  expect(row.count).toBe(2);
  expect(row.addresses.get(701)?.[0].title).toBe('sender@example.org');
  expect(row.addresses.get(704)?.[0]).toMatchObject({ title: 'Slack', detail: 'neri · workspace: garden-club' });
  expect(row.addresses.get(702)).toEqual([]);
  expect(row.addresses.has(703)).toBe(false);
  expect(row.addresses.get(704)?.map(address => address.title)).toEqual(['Slack', 'explicit@example.org', 'primary@example.org']);
  expect(row.addresses.get(705)?.map(address => address.title)).toEqual(['+1 202 555 0101']);
  expect(row.incomplete).toBe(true);
});

it('counts both addresses of one absorbed participant, including a later split', () => {
  const row = mergeSummaryRow({ merge: { ...detail.merge, absorbed_person_id: 9 }, labels: {
    profiles: [{ id: 9, participant_ids: [701] }], participants: [{ merge_id: 41, participant_id: 701, origin_side: 'absorbed', split_id: 55 }],
    members: [{ participant_id: 701, email: 'sender@example.org', normalized_value: 'sender@example.org' }], incomplete: false,
    identifiers: [{ participant_id: 701, type: 'phone', value: '+12025550101', display_value: '', normalized_value: '+12025550101', service_slug: 'phone', service_label: 'Phone', scope_kind: '', scope_value: '' }],
  } });
  expect(row.count).toBe(2);
});
