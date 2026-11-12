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
 * builds itself, saying that it needs a connection. (A trip's map tiles, the one public thing kept beyond this list, are 13.5; Background Sync is 6.2; push is 12.4.) A new
 * version waits until the pages that use the old one are closed (no `skipWaiting`), so what is in flight and the outbox are not disturbed.
 */
import { offlineAddressSources } from './addresses';

export const CACHE_PREFIX = 'waymark-shell-';

export function workerSource(version: string, files: readonly string[] = []): string {
  return `'use strict';
const CACHE = ${JSON.stringify(CACHE_PREFIX + version)};
const PREFIX = ${JSON.stringify(CACHE_PREFIX)};
/** The build's own files, which are kept when the worker installs: the allow-list of what a shell needs to start with no network. */
const FILES_OF_THE_BUILD = ${JSON.stringify(files)};
const BUILT = /^\\/_next\\/static\\//;
const FILES = /^\\/(icon\\.svg|favicon\\.ico|manifest\\.webmanifest|icons\\/[a-z0-9._-]+)$/;

/** The addresses the kept shell answers when there is no network (the app's screens, which read the device's own store). */
const SHELL_ADDRESSES = [${offlineAddressSources()
    .map((source) => `new RegExp(${JSON.stringify(source)})`)
    .join(', ')}];

const OFFLINE_PAGE = ${JSON.stringify(offlineHtml())};

function offline() {
  return new Response(OFFLINE_PAGE, {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      'cache-control': 'no-store',
    },
  });
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then(async (cache) => {
      await cache.add(new Request(self.location.origin + '/shell'));
      // The rest in a few at a time, none of it from a person's session: the same files for everyone.
      for (let i = 0; i < FILES_OF_THE_BUILD.length; i += 8) {
        await Promise.all(FILES_OF_THE_BUILD.slice(i, i + 8).map((file) => cache.add(new Request(self.location.origin + file)).catch(() => undefined)));
      }
    }),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(names.filter((name) => name.startsWith(PREFIX) && name !== CACHE).map((name) => caches.delete(name))),
    ),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith(navigate(request, url));
    return;
  }
  if (BUILT.test(url.pathname) || FILES.test(url.pathname)) {
    event.respondWith(kept(event, request));
  }
  // Anything else is not the worker's: it goes to the network as it would without one, and is never stored.
});

/** A built file or an icon: from the cache if it is there, else from the network and kept. They are the same for everyone. */
async function kept(event, request) {
  const cache = await caches.open(CACHE);
  const found = await cache.match(request);
  if (found) return found;
  const response = await fetch(request);
  if (response.ok && response.type !== 'opaque') event.waitUntil(cache.put(request, response.clone()));
  return response;
}

/**
 * A page: the network's, as it would be without a worker. With none, an address of the app's screens is the kept shell (the same page for everyone, which finds who is signed in on the device and
 * reads its store), and any other is the page that says it needs a connection. Nothing is kept.
 */
async function navigate(request, url) {
  try {
    return await fetch(request);
  } catch (error) {
    if (SHELL_ADDRESSES.some((pattern) => pattern.test(url.pathname))) {
      const cache = await caches.open(CACHE);
      const shell = await cache.match(new Request(url.origin + '/shell'));
      if (shell) return shell;
    }
    return offline();
  }
}
`;
}

/** The page the worker builds for an address it cannot answer without a connection: plain, with no script, and a way to try again. */
function offlineHtml(): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Needs a connection · Waymark</title><style>body{font-family:system-ui,sans-serif;margin:0;display:grid;min-height:100vh;place-items:center;background:#fff;color:#111}main{max-width:28rem;padding:1.5rem}a{color:inherit}@media (prefers-color-scheme:dark){body{background:#111;color:#eee}}</style></head><body><main><h1>This needs a connection</h1><p>Waymark could not reach its server. If you have used Waymark on this device, your check-ins and places are kept on it and open from the links below. Anything else needs a connection.</p><p><a href="/checkins">Check-ins</a> &middot; <a href="/places">Places</a></p></main></body></html>`;
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
