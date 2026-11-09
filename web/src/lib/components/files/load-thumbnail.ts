import { getFileContent as generatedGetFileContent } from '../../api/generated/api/api';
import type { APIClient } from '../../api/client';
import { isSupportedThumbnailMIME, readBoundedStream, validatedThumbnailBlob } from './preview-bytes';
import { withThumbnailSlot } from './thumbnail-queue';

export const MAX_THUMBNAIL_BYTES = 5 * 1024 * 1024;

/** Whether an archived file's metadata allows an automatic thumbnail at all.
 * Callers still need the bytes to pass validation in loadThumbnailURL. */
export function thumbnailAllowed(mimeType: string, sizeBytes: number): boolean {
  return isSupportedThumbnailMIME(mimeType) && sizeBytes <= MAX_THUMBNAIL_BYTES;
}

/** Loads an archived image through the authenticated API, validates its bytes
 * and decoded dimensions, and returns an object URL the caller must revoke.
 * Loads share the global thumbnail queue so a long list or thread cannot start
 * an unbounded number of requests at once. */
export function loadThumbnailURL(
  client: APIClient,
  id: number,
  mimeType: string,
  signal: AbortSignal
): Promise<string> {
  return withThumbnailSlot(signal, async () => {
    const { data, response } = await generatedGetFileContent({ id }, { ...client, signal });
    if (!response.ok || !(data instanceof ReadableStream)) {
      throw new Error('Archived thumbnail content could not be loaded.');
    }
    const bytes = await readBoundedStream(data, response.headers, signal, MAX_THUMBNAIL_BYTES);
    const blob = validatedThumbnailBlob(bytes, mimeType, response.headers.get('Content-Type'));
    return URL.createObjectURL(blob);
  });
}
