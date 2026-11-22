/**
 * The service worker (DESIGN.md §20.12), as the text served at `/sw.js`. It is a string and not a module because a worker is its own script, with no bundler
 * between it and the browser; it is written here, with a version and the build's files put in, so that a test evaluates the very text that is served. The
 * shape is Tusk's.
 *
 * **What it keeps, and nothing else:** the build's own files (the allow-list `files`, all under `/_next/static/`, the same for everyone), the icons and the
 * manifest, and **the one shell page, `/shell`**, which holds nothing of a person. Every other request, every API answer and every page with a person's data goes
 * to the network and is never stored: **no person's data is ever in the worker's cache** (DESIGN.md §20.12).
 *
 * **With no network,** Home, Check-ins, a check-in, Map, Places and a place (`src/sw/addresses.ts`) are answered with the kept shell page, which carries the policy and the nonce it was sent
 * with (the headers are kept with the body, so the two agree), and which draws the screen from the device's own store (`OfflineApp`). Every other address is answered with a page the worker
 * builds itself, saying that it needs a connection. **A trip's map tiles** are the one public thing kept beyond this list (13.5, DESIGN.md §14.5): the page asks for the tiles around a trip's stops by a message, the worker fetches them and keeps them in a cache of their own, and answers the map's requests for them from it, with no network too. The map files are public (the same for everyone), only the ones the page named are kept, and **only** addresses of the map (`/api/map/tiles/…`, the style for a theme and a font's glyphs) are taken. (Background Sync is 6.2.) It also shows a **push** (12.4) as a notification whose words it writes itself from the kind the push names, and opens the path the push names when it is tapped: a push carries nothing of a person's. A new
 * version waits until the pages that use the old one are closed (no `skipWaiting`), so what is in flight and the outbox are not disturbed.
 */
import { serviceWorkerSource } from '@sovereignfs/pwa';

export const CACHE_PREFIX = 'waymark-shell-';

/** Waymark's additions to the package's worker: the map's files and Web Push. */
function waymarkAdditions(): string {
  return `
/** A trip's map tiles: a cache of their own, which the shell's clean-up does not touch (its name has no shell prefix). The map's public files and nothing else. */
const TILES = 'waymark-tiles-v1';
const MAP_FILE = /^\\/api\\/map\\/(tiles\\/\\d{1,2}\\/\\d{1,7}\\/\\d{1,7}|style\\/(light|dark)\\.json|glyphs\\/[A-Za-z0-9%._ -]{1,64}\\/\\d{1,5}-\\d{1,5}\\.pbf)$/;
/** The most map files the worker keeps, whatever it is asked: a trip asks for a few hundred. */
const MAX_KEPT = 6000;
/** The most addresses one message may name. */
const MAX_ASKED = 1000;
// The map's files (a trip kept for offline): the package's worker leaves them to the network, so this listener answers them (the fetchHandlers of
// @sovereignfs/pwa 0.3.0 will take it).
self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET' || request.mode === 'navigate') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (MAP_FILE.test(url.pathname)) event.respondWith(mapFile(request));
});

/**
 * A push (DESIGN.md §17.3): the push service carries a kind and a path of this app and nothing else, so **the words are the worker's own**, chosen by the kind. A push that is not that is shown as the plain sentence it falls back to; a path that is not
 * a path of this app is not followed.
 */
const PUSH_WORDS = {
  import_finished: 'Your import has finished.',
  organizer_passed: 'A trip has passed to you.',
  trip_ready: 'A trip you are in has changed.',
  trip_dates: 'The dates of a trip you are in have changed.',
  role_changed: 'Your part in a trip has changed.',
  checkin_shared: 'A check-in was shared with a trip you are in.',
  edit_replaced: 'Someone changed an item right after you.',
  trip_starts: 'Your trip starts soon.',
  item_soon: 'Something on your trip is coming up.',
  day_plan: 'Today’s plan is ready.',
  invited: 'You are invited to a trip.',
  invite_accepted: 'Someone joined your trip.',
};
const PUSH_FALLBACK = 'Waymark has something for you.';
const isAppPath = (path) => typeof path === 'string' && /^\\/(?![/\\\\])/.test(path) && path.length < 500;

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (error) {
    data = {};
  }
  const kind = data && typeof data.k === 'string' ? data.k : '';
  const path = data && isAppPath(data.p) ? data.p : '/notifications';
  const body = Object.prototype.hasOwnProperty.call(PUSH_WORDS, kind) ? PUSH_WORDS[kind] : PUSH_FALLBACK;
  event.waitUntil(self.registration.showNotification('Waymark', { body, tag: kind || 'waymark', data: { path } }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data;
  const path = data && isAppPath(data.path) ? data.path : '/notifications';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
      const open = windows.find((each) => new URL(each.url).origin === self.location.origin);
      if (open) return open.navigate(self.location.origin + path).then((moved) => (moved || open).focus());
      return self.clients.openWindow(self.location.origin + path);
    }),
  );
});

/** A map file the page named earlier: from the cache if it is there (with no network too), else from the network as it would be without a worker, and not kept. */
async function mapFile(request) {
  const cache = await caches.open(TILES);
  const found = await cache.match(request);
  if (found) return found;
  try {
    return await fetch(request);
  } catch (error) {
    // With no network and the file not kept: a map draws what it has, and a tile that is not there is a gap.
    return new Response(null, { status: 503 });
  }
}

/** The addresses in a message that are the map's own and are of this origin, once each. A path is all that is taken: a whole address, another origin's or any other file is left out. */
function asked(urls) {
  if (!Array.isArray(urls)) return [];
  const out = [];
  for (const each of urls.slice(0, MAX_ASKED)) {
    if (typeof each === 'string' && MAP_FILE.test(each) && !out.includes(each)) out.push(each);
  }
  return out;
}

/** Fetches the files a page asked for and keeps those the network gave, a few at a time, up to the bound. Says what was kept and what was not. */
async function keepMap(urls, port) {
  const cache = await caches.open(TILES);
  const wanted = asked(urls);
  const have = (await cache.keys()).map((request) => new URL(request.url).pathname);
  const fresh = wanted.filter((path) => !have.includes(path));
  const room = Math.max(0, MAX_KEPT - have.length);
  const take = fresh.slice(0, room);
  let done = 0;
  let failed = fresh.length - take.length;
  for (let i = 0; i < take.length; i += 6) {
    await Promise.all(
      take.slice(i, i + 6).map(async (path) => {
        try {
          const response = await fetch(new Request(self.location.origin + path));
          if (response.ok) {
            await cache.put(new Request(self.location.origin + path), response);
            done += 1;
          } else failed += 1;
        } catch (error) {
          failed += 1;
        }
      }),
    );
    if (port) port.postMessage({ progress: Math.min(i + 6, take.length), total: take.length });
  }
  if (port) port.postMessage({ done: true, kept: wanted.length - failed, failed, total: wanted.length });
}

/** Forgets the files a page named, or all of them with none named: after a trip, and at sign-out. */
async function dropMap(urls, port) {
  if (urls === undefined || urls === null) await caches.delete(TILES);
  else {
    const cache = await caches.open(TILES);
    for (const path of asked(urls)) await cache.delete(new Request(self.location.origin + path));
  }
  if (port) port.postMessage({ done: true });
}

/** How many map files are kept and how many bytes they are, for Settings. */
async function mapStatus(port) {
  const cache = await caches.open(TILES);
  const requests = await cache.keys();
  let bytes = 0;
  for (const request of requests) {
    const response = await cache.match(request);
    if (response) bytes += (await response.clone().arrayBuffer()).byteLength;
  }
  if (port) port.postMessage({ done: true, files: requests.length, bytes });
}

self.addEventListener('message', (event) => {
  const data = event.data;
  const port = event.ports && event.ports[0];
  if (!data || typeof data.type !== 'string') return;
  if (data.type === 'keep-map') event.waitUntil(keepMap(data.urls, port));
  else if (data.type === 'drop-map') event.waitUntil(dropMap(data.urls, port));
  else if (data.type === 'map-status') event.waitUntil(mapStatus(port));
});
`;
}

export function workerSource(version: string, files: readonly string[] = []): string {
  return (
    serviceWorkerSource({
      version,
      cachePrefix: CACHE_PREFIX,
      precache: files,
      shell: '/shell',
      // The design system's grey 900 and white, as the manifest's colours are.
      offlineColors: { light: ['#ffffff', '#18181b'], dark: ['#18181b', '#fafafa'] },
    }) + waymarkAdditions()
  );
}

/**
 * The worker for a server that is not a production build (`next dev`): it keeps nothing, and removes itself and the caches of any other. A worker that kept
 * files there would show yesterday's code, since a development server's files do not change their names when they change.
 */
export function inertWorkerSource(): string {
  return `'use strict';
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(names.filter((name) => name.startsWith(${JSON.stringify(CACHE_PREFIX)})).map((name) => caches.delete(name))))
      .then(() => self.registration.unregister()),
  );
});
`;
}
