<script lang="ts">
  import { Checkbox, Spinner } from '@kenn-io/kit-ui';
  import { tick } from 'svelte';

  import DetailRow from '../people/DetailRow.svelte';
  import InlineNotice from '../common/InlineNotice.svelte';
  import MergeProfileCards from './MergeProfileCards.svelte';
  import type { PersonMergeHistoryController } from '../../directory/person-merge-history-controller.svelte';

  interface Props {
    controller: PersonMergeHistoryController;
    onOpenPerson: (personID: number) => void;
  }

  let { controller, onOpenPerson }: Props = $props();
  let splitContent = $state<HTMLDivElement>();
  let retryAction = $state<HTMLSpanElement>();

  const sourceName = $derived(controller.sourcePerson?.display_name?.trim() || 'this profile');
  const labels = $derived(controller.labels?.for === controller.detail ? controller.labels : null);
  /** An address as the person knows it, with its scope when it has one, so two alike addresses read apart. */
  function participantLabel(id: number): string {
    const addresses = labels?.addresses.get(id);
    return addresses ? addresses.map(address => address.detail ? `${address.title} · ${address.detail}` : address.title).join(', ') || 'No addresses' : `Unknown address ${(controller.sourcePerson?.participant_ids.indexOf(id) ?? -1) + 1}`;
  }
  /** Addresses still on the current profile, including those linked after this merge. */
  function remaining(moved: number[]): number[] {
    return (controller.sourcePerson?.participant_ids ?? []).filter(id => !moved.includes(id));
  }
  function card(title: string, ids: number[], empty: string) {
    return { title, empty, addresses: ids.map(id => ({ id: String(id), value: participantLabel(id) })) };
  }
  function count(rows: unknown[] | undefined, verb: string): string {
    const n = rows?.length ?? 0;
    return n ? `${n} ${n === 1 ? 'record' : 'records'} couldn't be ${verb}` : '';
  }
  const committed = $derived(controller.committedResult?.result ?? null);
  const partial = $derived(!!committed && (!committed.exact_reversal ||
    (committed.ambiguous_rows?.length ?? 0) > 0 || (committed.unrestored_rows?.length ?? 0) > 0));

  async function retryStaleState(): Promise<void> {
    const loaded = await controller.retryStaleSplitState();
    await tick();
    if (loaded) {
      const target = splitContent?.querySelector<HTMLElement>('input:not(:disabled)');
      if (target?.isConnected) target.focus();
    } else {
      const target = retryAction?.querySelector<HTMLElement>('button');
      if (target?.isConnected) target.focus();
    }
  }
</script>

  <div class="split" bind:this={splitContent} aria-busy={controller.splitBusy}>
    {#if committed}
      {@const remainingName = committed.source_person.display_name?.trim() || 'Remaining profile'}
      <!-- A receipt: the two people that now exist, each with its addresses. -->
      <section class="result">
        <div aria-label="Split result people">
          <DetailRow actionLabel={`Open ${remainingName}`} onclick={() => onOpenPerson(committed.source_person.id)} description={['Stays', ...committed.source_person.participant_ids.map(participantLabel)].join(' · ')}>{remainingName}</DetailRow>
          <DetailRow actionLabel={`Open ${committed.new_person.display_name?.trim() || 'new person'}`} onclick={() => onOpenPerson(committed.new_person.id)} description={[...(committed.new_person.display_name?.trim() ? ['New person'] : []), ...committed.new_person.participant_ids.map(participantLabel)].join(' · ') || undefined}>{committed.new_person.display_name?.trim() || 'New person'}</DetailRow>
        </div>
        {#if partial}
          <InlineNotice tone="warning" message="Partly restored. Review both people before editing them." details={[
            count(committed.ambiguous_rows, 'matched'), count(committed.unrestored_rows, 'restored'),
            committed.uid_alias_disposition === 'retired_uid_alias_retargeted' ? 'Links to the merged-in profile now open the new person' : `Links to the merged-in profile still open ${remainingName}`,
          ].filter(Boolean).join('\n')} />
        {/if}
        {#if !controller.committedResult?.receiptETags.source || !controller.committedResult?.receiptETags.created}<InlineNotice tone="info" message="Profile actions will load fresh data." />{/if}
        {#if controller.reconciliationError}<InlineNotice message="Couldn't refresh the profiles." actionLabel="Retry" onaction={() => void controller.retryReconciliation()} details={controller.reconciliationError} />{/if}
      </section>
    {:else if controller.sourceLoading}
      <p><Spinner size={12} label="Loading split source" /> Loading this profile…</p>
    {:else if controller.sourceError}
      <InlineNotice message="Couldn't load this profile." actionLabel="Retry" onaction={() => void controller.openSplit()} details={controller.sourceError} />
    {:else if controller.sourcePerson}
      {#if labels?.incomplete}<InlineNotice tone="warning" message="Some addresses couldn't be loaded." actionLabel="Retry" onaction={() => void controller.retryDetail()} />{/if}
      {#if controller.splitNeedsFreshState}
        <span bind:this={retryAction}><InlineNotice message="This profile changed since you opened it." actionLabel={controller.splitBusy ? 'Reloading…' : 'Retry'} onaction={() => { if (!controller.splitBusy) void retryStaleState(); }} details={controller.splitError ?? undefined} /></span>
      {:else if controller.isZeroParticipantLineage}
        <p>This merge has no addresses. Splitting restores its profile history.</p>
      {:else if controller.eligibleParticipantIDs.length === 0}
        <p role="status">No addresses in this merge can be split out.</p>
      {:else}
        <!-- The cards below name what moves and what stays, so the boxes need no lead. -->
        <fieldset disabled={controller.splitBusy} aria-label="Addresses to move">
          {#each controller.eligibleParticipantIDs as participantID}
            <Checkbox
              checked={controller.selectedParticipantIDs.includes(participantID)}
              label={participantLabel(participantID)}
              disabled={controller.splitBusy}
              onchange={(checked) => controller.setParticipantSelected(participantID, checked)}
            />
          {/each}
        </fieldset>
        <!-- What the split will leave, updated as boxes change. -->
        <MergeProfileCards label="After the split"
          from={card(`Stays with ${sourceName}`, remaining(controller.selectedParticipantIDs), 'No addresses')}
          to={card('New person', controller.selectedParticipantIDs, 'None chosen yet')} />
      {/if}

      {#if !controller.splitNeedsFreshState && controller.splitError}<InlineNotice message="Couldn't complete this split." details={controller.splitError} />{/if}
    {/if}
  </div>

<style>
  /* The address list is checkbox rows in a box padded 12, 8 apart; the cards follow 12 below it. */
  .split, .result { display: grid; gap: var(--space-box); min-width: 0; }
  .result { gap: var(--space-pane); }
  p { margin: 0; font-size: var(--type-body-size); line-height: var(--type-body-line); }
  fieldset { display: grid; gap: var(--space-group); min-width: 0; margin: 0; padding: var(--space-box); border: var(--border-width) solid var(--border-default); border-radius: var(--radius-sm); }
</style>
