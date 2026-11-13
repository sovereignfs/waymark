'use client';

/**
 * The page's side of a trip's kept maps (DESIGN.md §14.5): messages to the service worker, which fetches and keeps the map files a page names and answers the map's requests for them with no network (`src/sw/source.ts`). Each ask is
 * one message with a channel to answer on; a worker that is not there (a browser with none, or a development server, whose worker keeps nothing) is the answer `unavailable`, and the app works without.
 */
export type Progress = { readonly progress: number; readonly total: number };
export type KeepResult =
  | { readonly ok: true; readonly kept: number; readonly failed: number; readonly total: number }
  | { readonly ok: false; readonly reason: 'unavailable' };

async function worker(): Promise<ServiceWorker | undefined> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return undefined;
  try {
    const registered = await navigator.serviceWorker.getRegistration();
    // None registered (a development server's worker removes itself): there is nothing to ask, and nothing to wait for.
    if (!registered) return undefined;
    if (registered.active) return registered.active;
    const ready = await Promise.race([
      navigator.serviceWorker.ready,
      new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 4000)),
    ]);
    return ready?.active ?? undefined;
  } catch {
    return undefined;
  }
}

/** One message, and what the worker says back until it says it is done. */
function ask<T extends { done?: boolean }>(
  target: ServiceWorker,
  message: unknown,
  onProgress?: (progress: Progress) => void,
): Promise<T> {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = (event: MessageEvent) => {
      const said = event.data as T & Partial<Progress>;
      if (said.done) resolve(said);
      else if (onProgress && typeof said.progress === 'number' && typeof said.total === 'number')
        onProgress({ progress: said.progress, total: said.total });
    };
    target.postMessage(message, [channel.port2]);
  });
}

export async function keepTiles(
  urls: readonly string[],
  onProgress?: (progress: Progress) => void,
): Promise<KeepResult> {
  const target = await worker();
  if (!target) return { ok: false, reason: 'unavailable' };
  const said = await ask<{ done: true; kept: number; failed: number; total: number }>(
    target,
    { type: 'keep-map', urls },
    onProgress,
  );
  return { ok: true, kept: said.kept, failed: said.failed, total: said.total };
}

/** Lets go of some files, or all of them with none named. */
export async function dropTiles(urls?: readonly string[]): Promise<void> {
  const target = await worker();
  if (!target) return;
  await ask(target, urls === undefined ? { type: 'drop-map' } : { type: 'drop-map', urls });
}

export async function tilesStatus(): Promise<{ files: number; bytes: number } | undefined> {
  const target = await worker();
  if (!target) return undefined;
  const said = await ask<{ done: true; files: number; bytes: number }>(target, {
    type: 'map-status',
  });
  return { files: said.files, bytes: said.bytes };
}
