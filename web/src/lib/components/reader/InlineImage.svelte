<script lang="ts">
  import type { APIClient } from '../../api/client';
  import type { ArchiveAttachment } from '../../archive/types';
  import { loadThumbnailURL } from '../files/load-thumbnail';

  interface Props {
    client: APIClient;
    attachment: ArchiveAttachment;
  }

  let { client, attachment }: Props = $props();
  let imageURL = $state('');
  let activeObjectURL: string | undefined;
  let host = $state<HTMLElement>();
  let visible = $state(typeof IntersectionObserver === 'undefined');

  const href = $derived(`/api/v1/files/${attachment.id}/content`);
  const label = $derived(attachment.filename || '(unnamed file)');

  // A thread can hold hundreds of images, so bytes load only once the
  // attachment is near the viewport.
  $effect(() => {
    const element = host;
    if (!element || typeof IntersectionObserver === 'undefined') {
      visible = true;
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.target === element && entry.isIntersecting)) visible = true;
      },
      { rootMargin: '480px' },
    );
    observer.observe(element);
    return () => observer.disconnect();
  });

  $effect(() => {
    const id = attachment.id;
    const mimeType = attachment.mimeType;
    releaseImage();
    if (!visible) return;

    const controller = new AbortController();
    let current = true;
    void loadThumbnailURL(client, id, mimeType, controller.signal)
      .then((url) => {
        if (!current || controller.signal.aborted) {
          URL.revokeObjectURL(url);
          return;
        }
        activeObjectURL = url;
        imageURL = url;
      })
      // A rejected or unreadable image keeps the plain download link.
      .catch(() => undefined);

    return () => {
      current = false;
      controller.abort();
      releaseImage();
    };
  });

  function releaseImage(): void {
    if (activeObjectURL) URL.revokeObjectURL(activeObjectURL);
    activeObjectURL = undefined;
    imageURL = '';
  }
</script>

<a bind:this={host} {href} download={attachment.filename} class:inline-image={imageURL !== ''}>
  {#if imageURL}
    <img src={imageURL} alt={label} onerror={releaseImage} />
  {:else}
    {label}
  {/if}
</a>

<style>
  .inline-image {
    display: inline-block;
    line-height: 0;
  }
  img {
    display: block;
    max-width: min(100%, 360px);
    max-height: 360px;
    width: auto;
    height: auto;
    border-radius: var(--radius-md);
    background: var(--bg-inset);
  }
</style>
