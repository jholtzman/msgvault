<script lang="ts" module>
  export { MAX_THUMBNAIL_BYTES } from './load-thumbnail';
</script>

<script lang="ts">
  import type { APIClient } from '../../api/client';
  import type { PersonFileSearchRow } from '../../explore/models';
  import { loadThumbnailURL, thumbnailAllowed } from './load-thumbnail';

  interface Props {
    client: APIClient;
    file: PersonFileSearchRow;
  }

  let { client, file }: Props = $props();
  let imageURL = $state('');
  let thumbnailState = $state<'loading' | 'image' | 'video' | 'unavailable'>('loading');
  let activeObjectURL: string | undefined;
  let host = $state<HTMLDivElement>();
  let visible = $state(typeof IntersectionObserver === 'undefined');

  $effect(() => {
    const element = host;
    if (!element || typeof IntersectionObserver === 'undefined') {
      visible = true;
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        visible = entries.some((entry) => entry.target === element && entry.isIntersecting);
      },
      { rootMargin: '240px' },
    );
    observer.observe(element);
    return () => observer.disconnect();
  });

  $effect(() => {
    const id = file.id;
    const family = file.mime_family;
    const mimeType = file.mime_type;
    const size = file.size_bytes;
    const available = file.content_available && file.content_state === 'local_content';
    releaseImage();

    if (family === 'video') {
      thumbnailState = 'video';
      return;
    }
    if (family !== 'image' || !available || !thumbnailAllowed(mimeType, size)) {
      thumbnailState = 'unavailable';
      return;
    }
    if (!visible) {
      thumbnailState = 'loading';
      return;
    }

    thumbnailState = 'loading';
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
        thumbnailState = 'image';
      })
      .catch(() => {
        if (current && !controller.signal.aborted) thumbnailState = 'unavailable';
      });

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

  function imageFailed(): void {
    releaseImage();
    thumbnailState = 'unavailable';
  }
</script>

<div class="thumbnail" bind:this={host}>
  {#if thumbnailState === 'image'}
    <img src={imageURL} alt={`Thumbnail ${file.filename || `attachment ${file.id}`}`} onerror={imageFailed} />
  {:else if thumbnailState === 'video'}
    <span class="placeholder" data-kind="video"><strong>Video</strong><small>{file.mime_type}</small></span>
  {:else if thumbnailState === 'loading'}
    <span class="placeholder" role="status">Loading thumbnail…</span>
  {:else}
    <span class="placeholder" data-kind="unavailable">Image preview unavailable</span>
  {/if}
</div>

<style>
  .thumbnail {
    display: grid;
    width: 100%;
    aspect-ratio: 4 / 3;
    place-items: center;
    overflow: hidden;
    background: var(--bg-inset);
  }
  img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  .placeholder {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: var(--space-1);
    flex-direction: column;
    padding: var(--space-3);
    color: var(--text-muted);
    font-size: var(--font-size-xs);
    text-align: center;
  }
  .placeholder strong {
    color: var(--text-secondary);
    font-size: var(--font-size-sm);
  }
  .placeholder small {
    font-size: var(--font-size-2xs);
  }
</style>
