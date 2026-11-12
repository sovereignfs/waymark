import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { CACHE_PREFIX, inertWorkerSource, workerSource } from './source';

/**
 * The service worker (DESIGN.md §20.12): **what it keeps is an allow-list, and nothing else gets in.** This evaluates the very text that is served, with a cache
 * and a network that the test controls, and looks at what is in the cache after everything a person does: no page with their data, no answer from an API.
 */
const ORIGIN = 'https://waymark.test';
const FILES = [
  '/_next/static/chunks/a.js',
  '/_next/static/chunks/b.css',
  '/_next/static/media/font.woff2',
];

/** Every address the worker may keep, which is the whole of its allow-list: the shell, the build's files, the icons and the manifest. */
const ALLOWED =
  /^\/(shell|_next\/static\/.+|icon\.svg|favicon\.ico|manifest\.webmanifest|icons\/[a-z0-9._-]+)$/;

type Listener = (event: Record<string, unknown>) => void;

function load(version = 'v1', files: readonly string[] = FILES) {
  const stores = new Map<string, Map<string, Response>>();
  const state = { online: true };
  const network = async (input: Request | string): Promise<Response> => {
    const request = typeof input === 'string' ? new Request(`${ORIGIN}${input}`) : input;
    if (!state.online) throw new TypeError('no network');
    const path = new URL(request.url).pathname;
    if (path === '/shell') return new Response('<html>the shell, for everyone</html>');
    if (/^\/(icons\/|manifest\.webmanifest|icon\.svg|favicon\.ico)/.test(path))
      return new Response('an icon');
    if (path.startsWith('/_next/static/')) return new Response('file');
    if (path.startsWith('/api/')) return new Response('{"name":"Ada","email":"ada@example.com"}');
    return new Response(`<html>Ada Lovelace, ada@example.com ${path}</html>`);
  };
  const keyOf = (r: Request | string) =>
    (typeof r === 'string' ? new Request(`${ORIGIN}${r}`) : r).url;
  const cacheOf = (name: string) => {
    let store = stores.get(name);
    if (!store) stores.set(name, (store = new Map()));
    const kept = store;
    return {
      match: async (r: Request | string) => kept.get(keyOf(r))?.clone(),
      put: async (r: Request | string, response: Response) => void kept.set(keyOf(r), response),
      add: async (r: Request | string) => {
        const request = typeof r === 'string' ? new Request(`${ORIGIN}${r}`) : r;
        const response = await network(request);
        if (!response.ok) throw new TypeError('not ok');
        kept.set(keyOf(request), response);
      },
    };
  };
  const listeners: Record<string, Listener> = {};
  const self = {
    location: { origin: ORIGIN },
    addEventListener: (type: string, listener: Listener) => (listeners[type] = listener),
    skipWaitingCalled: false,
  };
  const context = vm.createContext({
    self,
    caches: {
      open: async (name: string) => cacheOf(name),
      keys: async () => [...stores.keys()],
      delete: async (name: string) => stores.delete(name),
    },
    fetch: (input: Request) => network(input),
    Request,
    Response,
    URL,
    TypeError,
  });
  vm.runInContext(workerSource(version, files), context);

  /** Runs a lifecycle event and waits for what it asked to wait for. */
  async function lifecycle(type: 'install' | 'activate') {
    let waiting: Promise<unknown> = Promise.resolve();
    listeners[type]?.({ waitUntil: (p: Promise<unknown>) => (waiting = p) });
    await waiting;
  }

  /** A request, answered by the worker or not (`undefined`: it is not the worker's, and goes to the network as it would without one). */
  async function ask(path: string, init: { method?: string; mode?: string; origin?: string } = {}) {
    const request = Object.assign(
      new Request(`${init.origin ?? ORIGIN}${path}`, { method: init.method ?? 'GET' }),
      {},
    );
    Object.defineProperty(request, 'mode', { value: init.mode ?? 'cors' });
    let answer: Promise<Response> | undefined;
    const pending: Promise<unknown>[] = [];
    listeners.fetch?.({
      request,
      respondWith: (p: Promise<Response>) => (answer = p),
      waitUntil: (p: Promise<unknown>) => pending.push(p),
    });
    const response = answer ? await answer : undefined;
    await Promise.all(pending);
    return response;
  }

  const kept = () =>
    [...stores.entries()].flatMap(([cache, store]) =>
      [...store.keys()].map((url) => ({ cache, path: new URL(url).pathname })),
    );
  return { lifecycle, ask, kept, stores, state, self };
}

describe('the service worker', () => {
  it('keeps, as it installs, the shell and the build’s files, and nothing else', async () => {
    const worker = load();
    await worker.lifecycle('install');
    expect(
      worker
        .kept()
        .map((each) => each.path)
        .sort(),
    ).toEqual(['/shell', ...FILES].sort());
    expect(worker.kept().every((each) => each.cache === `${CACHE_PREFIX}v1`)).toBe(true);
  });

  it('caches nothing outside the allow-list, whatever a person does: pages, answers of the API, a place, a note', async () => {
    const worker = load();
    await worker.lifecycle('install');
    const addresses = [
      '/',
      '/checkins',
      '/c/6f1d1f1c-2d9e-4f5b-9a67-0a6a7c1e3d11',
      '/map',
      '/places',
      '/places/6f1d1f1c-2d9e-4f5b-9a67-0a6a7c1e3d11',
      '/settings',
      '/notifications',
      '/import',
      '/t/6f1d1f1c-2d9e-4f5b-9a67-0a6a7c1e3d11',
      '/api/sync',
      '/api/ops',
      '/api/places?q=lisbon',
      '/api/map/tiles/5/10/12.pbf',
      '/api/media/6f1d1f1c-2d9e-4f5b-9a67-0a6a7c1e3d11',
      '/api/health',
      '/sign-in',
      '/shell?x=1',
    ];
    for (const path of addresses) {
      await worker.ask(path, { mode: 'navigate' });
      await worker.ask(path);
    }
    for (const each of worker.kept()) expect(each.path, each.path).toMatch(ALLOWED);
    expect(worker.kept().some((each) => each.path.startsWith('/api/'))).toBe(false);
  });

  it('answers a built file and an icon from what it kept, and keeps the first it is asked for that it did not have', async () => {
    const worker = load();
    await worker.lifecycle('install');
    expect(await (await worker.ask(FILES[0] ?? ''))?.text()).toBe('file');
    await worker.ask('/icons/icon-192.png');
    expect(worker.kept().map((each) => each.path)).toContain('/icons/icon-192.png');
    worker.state.online = false;
    expect(await (await worker.ask('/icons/icon-192.png'))?.text()).toBe('an icon');
    expect(await (await worker.ask(FILES[1] ?? ''))?.text()).toBe('file');
  });

  it('is not asked to answer what is not a GET, or another origin’s, and answers a built file only from this origin', async () => {
    const worker = load();
    await worker.lifecycle('install');
    expect(await worker.ask('/api/sync', { method: 'POST' })).toBeUndefined();
    expect(await worker.ask('/api/ops', { method: 'PUT' })).toBeUndefined();
    expect(
      await worker.ask('/_next/static/chunks/a.js', { origin: 'https://elsewhere.test' }),
    ).toBeUndefined();
    // Another thing under this origin that is not on the list is not the worker's either.
    expect(await worker.ask('/api/places?q=lisbon')).toBeUndefined();
    expect(await worker.ask('/c/abc')).toBeUndefined();
  });

  it('answers a page from the network as it would without a worker, and with none, says that it needs a connection', async () => {
    const worker = load();
    await worker.lifecycle('install');
    const online = await worker.ask('/settings', { mode: 'navigate' });
    expect(await online?.text()).toContain('Ada Lovelace');
    worker.state.online = false;
    const offline = await worker.ask('/settings', { mode: 'navigate' });
    const body = (await offline?.text()) ?? '';
    expect(body).toContain('This needs a connection');
    // The page it builds says nothing of anyone, and allows no script.
    expect(body).not.toContain('Ada');
    expect(offline?.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(offline?.headers.get('cache-control')).toBe('no-store');
    // And it kept none of what it was asked for.
    expect(worker.kept().some((each) => each.path === '/settings')).toBe(false);
  });

  it('with no network, answers each of the app’s screens with the kept shell, which is the same for everyone', async () => {
    const worker = load();
    await worker.lifecycle('install');
    worker.state.online = false;
    for (const path of [
      '/',
      '/home',
      '/checkins',
      '/c/0a1b2c3d-1111-2222-3333-444455556666',
      '/map',
      '/places',
      '/places/p_1-A',
    ]) {
      const answer = await worker.ask(path, { mode: 'navigate' });
      expect(await answer?.text(), path).toBe('<html>the shell, for everyone</html>');
    }
    // Asking for them kept nothing: the cache is still the allow-list.
    expect(worker.kept().every((each) => ALLOWED.test(each.path))).toBe(true);
  });

  it('with no network, answers every other address with the page that needs a connection, never the shell', async () => {
    const worker = load();
    await worker.lifecycle('install');
    worker.state.online = false;
    for (const path of [
      '/settings',
      '/notifications',
      '/places/',
      '/checkins/extra',
      '/c/',
      '/c/a/b',
      '/sign-in',
      '/shell/x',
      '/homes',
      '/api/health',
    ]) {
      const answer = await worker.ask(path, { mode: 'navigate' });
      const body = (await answer?.text()) ?? '';
      expect(body, path).toContain('This needs a connection');
      expect(body, path).not.toContain('the shell');
    }
  });

  it('with no network and no shell kept, still says that it needs a connection', async () => {
    const worker = load();
    worker.state.online = false;
    const answer = await worker.ask('/checkins', { mode: 'navigate' });
    expect(await answer?.text()).toContain('This needs a connection');
  });

  it('with a network, answers a screen from the network as it would without a worker', async () => {
    const worker = load();
    await worker.lifecycle('install');
    const answer = await worker.ask('/checkins', { mode: 'navigate' });
    expect(await answer?.text()).toContain('Ada Lovelace');
  });

  it('removes the caches of older versions when a new one activates, and no cache that is not its own', async () => {
    const worker = load('v2');
    worker.stores.set(`${CACHE_PREFIX}v1`, new Map());
    worker.stores.set('someone-elses', new Map());
    await worker.lifecycle('install');
    await worker.lifecycle('activate');
    expect([...worker.stores.keys()].sort()).toEqual([`${CACHE_PREFIX}v2`, 'someone-elses'].sort());
  });

  it('waits for the pages that use the old version to close: it never takes over by itself', () => {
    const text = workerSource('v1');
    expect(text).not.toContain('skipWaiting');
    expect(text).not.toContain('clients.claim');
  });

  it('is the build’s: a new build is a new cache', () => {
    expect(workerSource('abc')).toContain(`${CACHE_PREFIX}abc`);
    expect(workerSource('abd')).not.toContain(`${CACHE_PREFIX}abc`);
  });

  it('reads no device store and names no check-in, address or note: the source says none of them', () => {
    const text = workerSource('v1');
    for (const word of ['indexedDB', 'localStorage', 'checkin', 'email', 'note'])
      expect(text, word).not.toMatch(new RegExp(`\\b${word}\\b`, 'i'));
  });
});

describe('the worker of a server that is not a production build', () => {
  it('keeps nothing, takes over at once, and removes itself and the caches of Waymark', () => {
    const text = inertWorkerSource();
    expect(text).toContain('skipWaiting');
    expect(text).toContain('unregister');
    expect(text).not.toContain('cache.add');
    expect(text).toContain(CACHE_PREFIX);
  });
});
