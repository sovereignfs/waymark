import type { LocalStore } from './store';

/**
 * Photos waiting (DESIGN.md §9.3, §15.6): **a photo taken with no network is kept on the device under the id the device made, and uploaded when there is one**, before or after the check-in's mutation (the
 * server accepts a check-in whose photo has not arrived, and shows a placeholder until it does). It is shown from the device meanwhile, and its file goes from here once the server has it.
 *
 *  - A failure that may pass (no network, a busy or broken server) is **retried with a backoff** that doubles from five seconds to ten minutes.
 *  - **A photo the server would not take** (too large, not an image, over the person's room) goes to **Couldn't sync** with the server's sentence, **and its file stays** until the person sends it again or
 *    discards it: it is not tried again by itself.
 *  - A session that has ended stops the run, and keeps every photo.
 */
export type Put = (id: string, blob: Blob) => Promise<{ status: number; json: unknown }>;

/** The browser's: a PUT of the file's bytes to this app's own server, under the id the device made. The server judges the bytes and never the name or the type. */
export const fetchPut: Put = async (id, blob) => {
  const response = await fetch(`/api/media/${encodeURIComponent(id)}?kind=photo`, {
    method: 'PUT',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/octet-stream' },
    body: blob,
  });
  const json: unknown = await response.json().catch(() => null);
  return { status: response.status, json };
};

export type UploadState = 'ok' | 'offline' | 'signed_out' | 'busy';

/** What a refusal says, from the server's own sentence; a sentence of ours when it did not give one. */
function sentenceOf(json: unknown): string {
  const message =
    typeof json === 'object' && json !== null ? (json as { message?: unknown }).message : undefined;
  return typeof message === 'string' && message !== '' && message.length < 300
    ? message
    : 'The server could not take this photo.';
}

/** One run: uploads each photo that is due, one after another, and says how it ended. */
export async function uploadPhotos(
  store: LocalStore,
  put: Put,
  now: () => number = Date.now,
): Promise<UploadState> {
  let ended: UploadState = 'ok';
  for (const photo of await store.photosDue(now())) {
    let reply: { status: number; json: unknown };
    try {
      reply = await put(photo.id, new Blob([photo.data], { type: photo.type }));
    } catch {
      await store.photoFailed(photo.id, now());
      // No network for one is none for the rest: not a request for each.
      return 'offline';
    }
    if (reply.status === 200 || reply.status === 201) await store.photoUploaded(photo.id);
    else if (reply.status === 401) return 'signed_out';
    else if (reply.status === 429) {
      await store.photoFailed(photo.id, now());
      return 'busy';
    } else if (reply.status >= 500) {
      await store.photoFailed(photo.id, now());
      ended = 'offline';
    } else if (reply.status === 404) {
      // The id is not ours to use: the same answer as for a file that is not there, and a photo that will never be taken.
      await store.photoRefused(photo.id, 'not_found', 'The server could not take this photo.');
    } else await store.photoRefused(photo.id, `status_${reply.status}`, sentenceOf(reply.json));
  }
  return ended;
}
