import type { PersonClusterMember, PersonMergeDetail, PersonMergeLabels } from '../api/generated/models';
import { identityChipText } from '../relationships/identity-chip';

export interface AddressIdentity { normalized_value?: string; service_slug?: string; scope_kind?: string; scope_value?: string }
type AddressLabel = AddressIdentity & { title: string; detail: string };
export function addressText(address: { title: string; detail?: string } | undefined): string | undefined {
  return address ? [address.title, address.detail].filter(Boolean).join(' · ') : undefined;
}
export interface MergeLabels { names: Map<number, string>; addresses: Map<number, AddressLabel[]>; incomplete: boolean }
export interface MergeRow extends MergeLabels { count: number; absorbedAddress?: string; mergedIn: MergedInAddress[] }
export interface MergeAddress extends AddressIdentity { id: string; participantID: number; value: string; detail?: string; splitID?: number }
export interface MergedInAddress extends AddressIdentity { mergeID: number; participantID: number; value: string; mergedAt: string }

/**
 * "{absorbed} merged into {survivor}". When one name contains the other, as
 * with "Mira Vale · work" and "Mira Vale", or the absorbed profile has no name,
 * it is named by its first address so the two read apart.
 */
export function mergeSentence(absorbed: string | undefined, survivor: string | undefined, absorbedAddress?: string): string {
  return `${absorbedCardTitle(absorbed, survivor, absorbedAddress)} merged into ${survivor ?? 'this profile'}`;
}

/**
 * The absorbed profile's name on the merge's title and card: its name, or its
 * first address when the names read alike or it has none. "Merged-in profile"
 * only when it has neither.
 */
export function absorbedCardTitle(absorbed: string | undefined, survivor: string | undefined, firstAddress?: string): string {
  return namedByAddress(absorbed, survivor) ? firstAddress ?? absorbed ?? 'Merged-in profile' : absorbed!;
}

/** Whether the absorbed profile goes by its first address, so its card leaves that address out of the list. */
export function namedByAddress(absorbed: string | undefined, survivor: string | undefined): boolean {
  return !absorbed || (!!survivor && sameName(absorbed, survivor));
}

export function sameName(left: string, right: string): boolean {
  const a = left.trim().toLocaleLowerCase(), b = right.trim().toLocaleLowerCase();
  return !!a && !!b && (a.includes(b) || b.includes(a));
}

/** The addresses each side brought to a merge, in participant order. */
export function mergeAddresses(detail: Pick<PersonMergeDetail, 'participants'>, labels: Pick<MergeLabels, 'addresses'> | null, side: 'absorbed' | 'survivor'): MergeAddress[] {
  return (detail.participants ?? []).filter(participant => participant.origin_side === side).flatMap(participant => {
    const addresses = labels?.addresses.get(participant.participant_id);
    return (addresses ?? [{ title: 'Unknown address', detail: '' }]).map((address, index) => ({
      ...address, id: `${participant.participant_id}-${index}`, participantID: participant.participant_id,
      value: address.title, detail: address.detail || undefined, splitID: participant.split_id,
    }));
  });
}

/** The server supplies recorded names and canonical identities for a page or selected merge. */
export function mergeSummaryRow(item: { merge: PersonMergeDetail['merge']; labels: PersonMergeLabels }): MergeRow {
  const labels = item.labels;
  const names = new Map(labels.profiles.flatMap(profile => profile.display_name ? [[profile.id, profile.display_name] as const] : []));
  const addresses = new Map<number, AddressLabel[]>();
  for (const id of new Set([...labels.members.map(member => member.participant_id), ...labels.identifiers.map(identifier => identifier.participant_id)])) {
    const member: PersonClusterMember | undefined = labels.members.find(member => member.participant_id === id);
    const identifiers = labels.identifiers.filter(identifier => identifier.participant_id === id);
    const primary = member?.email || member?.phone;
    addresses.set(id, identifiers.length ? identifiers.map(identifier => ({
      ...identityChipText(identifier, member, []), ...identifier,
      ...(['email', 'phone'].includes(identifier.type) ? { detail: '' } : {}),
    })) : primary ? [{ title: primary, detail: '', normalized_value: member?.normalized_value, service_slug: member?.email ? 'email' : 'phone' }] : []);
  }
  const rows = mergeAddresses(labels, { addresses }, 'absorbed');
  return {
    names, addresses, incomplete: labels.incomplete || labels.participants.some(participant => !addresses.has(participant.participant_id)),
    count: labels.profiles.find(profile => profile.id === item.merge.absorbed_person_id)?.participant_ids.length ?? 0,
    absorbedAddress: addressText(addresses.get(rows[0]?.participantID ?? 0)?.[0]),
    mergedIn: rows.filter(address => address.splitID === undefined && address.value !== 'Unknown address').map(address => ({
      ...address, mergeID: item.merge.id, value: addressText({ title: address.value, detail: address.detail })!, mergedAt: item.merge.created_at,
    })),
  };
}
