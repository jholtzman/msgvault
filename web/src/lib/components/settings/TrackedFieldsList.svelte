<script lang="ts">
  import { Disclosure } from '@kenn-io/kit-ui';
  import { onDestroy, onMount, untrack } from 'svelte';
  import InlineNotice from '../common/InlineNotice.svelte';
  import EmptyLine from '../common/EmptyLine.svelte';
  import { listAttributeDefinitions } from '../../api/generated/api/api';
  import type { APIClient } from '../../api/client';
  import { sentenceCase } from '../../explore/labels';
  import { PersonTrackingController, type PersonTrackingTarget } from '../../directory/person-tracking-controller.svelte';

  let { client }: { client: APIClient } = $props();
  const controller = new PersonTrackingController(untrack(() => client));
  let labels = $state(new Map<string, string>());
  let sensitiveOpen = $state(false);
  const namesAbort = new AbortController();
  onMount(() => {
    void controller.retryCatalog(false);
    // Without the field names, a field reads as its slug in words.
    void listAttributeDefinitions({ object_type: 'person' }, { ...client, signal: namesAbort.signal })
      .then(response => { if (!namesAbort.signal.aborted && response.data) labels = new Map((response.data.definitions ?? []).map(definition => [definition.slug, definition.label])); })
      .catch(() => undefined);
  });
  onDestroy(() => { namesAbort.abort(); controller.destroy(); });

  function label(target: PersonTrackingTarget): string {
    return target.kind === 'employment' ? 'Work · job title, organization, and dates' : labels.get(target.slug) ?? sentenceCase(target.slug);
  }
  const sensitive = $derived(controller.targets.filter(target => target.sensitive));
</script>

<!-- The fields Keep this profile updated may change on a person: a heading 8 above 36 rows, then the fold. -->
<section class="tracked-fields" aria-labelledby="tracked-fields-heading">
  <h3 id="tracked-fields-heading">Fields kept updated</h3>
  {#if controller.catalogLoading && !controller.targets.length}<p role="status">Loading fields…</p>{/if}
  <ul>{#each controller.targets.filter(target => !target.sensitive) as target (target.key)}<li>{label(target)}</li>{/each}</ul>
  {#if !controller.catalogLoading && !controller.catalogError && !controller.targets.length}<EmptyLine message="No fields yet" />{/if}
  {#if controller.catalogError}<InlineNotice message="Couldn't load the fields kept updated." actionLabel="Retry" onaction={() => void controller.retryCatalog(sensitiveOpen)} details={controller.catalogError} />{/if}
  <Disclosure variant="plain" class="fold" title="Show sensitive fields" bind:open={sensitiveOpen} ontoggle={(open) => { if (open && !controller.catalogIncludesSensitive) void controller.retryCatalog(true); }}>
    {#if controller.catalogIncludesSensitive && !sensitive.length}<EmptyLine message="No sensitive fields" />{/if}
    <ul>{#each sensitive as target (target.key)}<li>{label(target)}</li>{/each}</ul>
  </Disclosure>
</section>

<style>
  .tracked-fields { display: grid; min-width: 0; }
  h3, p, ul { margin: 0; }
  h3 { margin-bottom: var(--space-group); font-size: var(--type-heading-size); line-height: var(--type-heading-line); }
  p { color: var(--text-muted); font-size: var(--type-meta-size); line-height: var(--type-meta-line); }
  ul { padding: 0; list-style: none; }
  li { padding: var(--row-pad-y) var(--row-pad-x); box-shadow: inset 0 -1px 0 var(--border-muted); font-size: var(--type-body-size); line-height: var(--type-body-line); }
</style>
