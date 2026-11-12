import { expect, test } from '@playwright/test';
import { goOffline, signedIn } from './helpers';

/**
 * The PWA (DESIGN.md §20.12): installable (a manifest with the icons a browser asks for), and a service worker that keeps the build's files and the one shell
 * page and **nothing of a person**. A page with no connection says that it needs one.
 */
test.use({ viewport: { width: 1280, height: 800 } });

/** The worker has installed, kept its files, and is in control of the page. */
async function workerReady(page: import('@playwright/test').Page) {
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => true));
  await expect
    .poll(async () =>
      page.evaluate(async () => {
        const names = (await caches.keys()).filter((name) => name.startsWith('waymark-shell-'));
        for (const name of names) if (await (await caches.open(name)).match('/shell')) return true;
        return false;
      }),
    )
    .toBe(true);
}

test('the manifest and icons make it installable, and the worker is served from the root', async ({
  page,
  request,
}) => {
  await signedIn(page);
  const link = await page.locator('link[rel="manifest"]').getAttribute('href');
  expect(link).toBeTruthy();
  const manifest = await (await request.get(link ?? '/manifest.webmanifest')).json();
  expect(manifest).toMatchObject({
    name: 'Waymark',
    short_name: 'Waymark',
    display: 'standalone',
    start_url: '/',
    scope: '/',
  });
  const icons = manifest.icons as { src: string; sizes: string; type: string; purpose?: string }[];
  expect(icons.some((i) => i.sizes === '192x192' && i.purpose === 'any')).toBe(true);
  expect(icons.some((i) => i.sizes === '512x512' && i.purpose === 'any')).toBe(true);
  expect(icons.some((i) => i.purpose === 'maskable')).toBe(true);
  for (const icon of icons) {
    const reply = await request.get(icon.src);
    expect(reply.status(), icon.src).toBe(200);
    expect(reply.headers()['content-type'], icon.src).toContain('image/png');
  }
  await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveCount(1);

  const worker = await request.get('/sw.js');
  expect(worker.status()).toBe(200);
  expect(worker.headers()['content-type']).toContain('javascript');
  expect(worker.headers()['service-worker-allowed']).toBe('/');
  expect(worker.headers()['cache-control']).toContain('no-cache');
  expect(await worker.text()).toContain('/shell');
});

test('the shell is the same for everyone, and is a page with the policy', async ({ request }) => {
  const reply = await request.get('/shell');
  expect(reply.status()).toBe(200);
  expect(reply.headers()['content-security-policy']).toContain("script-src 'self' 'nonce-");
  const html = await reply.text();
  expect(html).toContain('Waymark');
  expect(html).not.toMatch(/"accountId"/);
});

test('the worker installs, keeps the shell and the build’s files and nothing else, and says a page needs a connection when there is none', async ({
  page,
  context,
}) => {
  await signedIn(page);
  await page.goto('/checkins');
  await workerReady(page);
  // Pages and answers a person would see, fetched with the worker in control.
  await page.goto('/map');
  await page.goto('/places');
  await page.evaluate(() => fetch('/api/health').then((r) => r.status));

  const kept = await page.evaluate(async () => {
    const out: string[] = [];
    for (const name of await caches.keys()) {
      for (const request of await (await caches.open(name)).keys())
        out.push(new URL(request.url).pathname);
    }
    return out;
  });
  expect(kept).toContain('/shell');
  expect(kept.some((path) => path.startsWith('/_next/static/'))).toBe(true);
  for (const path of kept)
    expect(path, path).toMatch(
      /^\/(shell|_next\/static\/.+|icon\.svg|favicon\.ico|manifest\.webmanifest|icons\/[a-z0-9._-]+)$/,
    );

  await goOffline(context);
  // Settings is read from the server, so with no network it says so (the app's own screens open from the device: e2e/offline.spec.ts).
  await page.goto('/settings');
  await expect(page.getByRole('heading', { name: 'This needs a connection' })).toBeVisible();
});
