import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import sharp from 'sharp';
import { PORTS } from './ports';
import { secondContext, signedIn } from './helpers';

/**
 * Files, through the routes a browser calls (DESIGN.md §18.3): an image is re-encoded and served with the headers a file must have, a file is judged by its bytes, and a visitor, or a
 * request from another origin, gets nothing. (Another person's file is the data-layer test's: this instance is closed to a second account.)
 */
const ORIGIN = `http://localhost:${PORTS.app}`;
/** A small PNG, made here (and not typed in, which is how a broken one gets in). */
let PNG: Buffer;
test.beforeAll(async () => {
  PNG = await sharp({
    create: { width: 8, height: 8, channels: 3, background: { r: 30, g: 120, b: 200 } },
  })
    .png()
    .toBuffer();
});

test('a signed-in person adds a photo, gets it back re-encoded with the right headers, and deletes it', async ({
  page,
}) => {
  await signedIn(page);
  const added = await page.request.post('/api/media?kind=photo', {
    headers: { origin: ORIGIN, 'content-type': 'application/octet-stream' },
    data: PNG,
  });
  expect(added.status()).toBe(201);
  const { id, thumbId } = (await added.json()) as { id: string; thumbId: string };
  expect(id).toMatch(/^[0-9a-f-]{36}$/);
  expect(thumbId).toMatch(/^[0-9a-f-]{36}$/);

  const file = await page.request.get(`/api/media/${id}`);
  expect(file.status()).toBe(200);
  expect(file.headers()['content-type']).toBe('image/webp');
  expect(file.headers()['x-content-type-options']).toBe('nosniff');
  expect(file.headers()['cache-control']).toContain('private');
  expect(file.headers()['content-security-policy']).toContain("default-src 'none'");
  const body = await file.body();
  expect(body.subarray(0, 4).toString('latin1')).toBe('RIFF');
  expect(body.subarray(8, 12).toString('latin1')).toBe('WEBP');
  expect((await page.request.get(`/api/media/${thumbId}`)).status()).toBe(200);

  const gone = await page.request.delete(`/api/media/${id}`, { headers: { origin: ORIGIN } });
  expect(gone.status()).toBe(204);
  expect((await page.request.get(`/api/media/${id}`)).status()).toBe(404);
  expect((await page.request.get(`/api/media/${thumbId}`)).status()).toBe(404);
});

test('a file is judged by its bytes: an HTML page named .jpg is refused with a sentence', async ({
  page,
}) => {
  await signedIn(page);
  const refused = await page.request.post('/api/media?kind=photo', {
    headers: { origin: ORIGIN, 'content-type': 'image/jpeg' },
    multipart: undefined,
    data: Buffer.from('<!doctype html><script>alert(1)</script>'),
  });
  expect(refused.status()).toBe(415);
  const body = (await refused.json()) as { code: string; message: string };
  expect(body.code).toBe('NOT_ALLOWED');
  expect(body.message).toMatch(/cannot be added/);
  expect(
    (
      await page.request.post('/api/media?kind=nonsense', {
        headers: { origin: ORIGIN },
        data: PNG,
      })
    ).status(),
  ).toBe(415);
});

test('a photo with an id the device made is added once, however many times it is sent', async ({
  page,
}) => {
  await signedIn(page);
  const id = randomUUID();
  const send = () =>
    page.request.put(`/api/media/${id}?kind=photo`, { headers: { origin: ORIGIN }, data: PNG });
  expect((await send()).status()).toBe(201);
  expect((await send()).status()).toBe(200);
  expect((await page.request.get(`/api/media/${id}`)).status()).toBe(200);
  expect(
    (
      await page.request.put('/api/media/not-an-id?kind=photo', {
        headers: { origin: ORIGIN },
        data: PNG,
      })
    ).status(),
  ).toBe(400);
});

test('a visitor, and a request from another origin, get nothing', async ({ page, browser }) => {
  await signedIn(page);
  const { id } = (await (
    await page.request.post('/api/media?kind=photo', { headers: { origin: ORIGIN }, data: PNG })
  ).json()) as { id: string };

  // Another browser, signed in as no one.
  const visitor = await secondContext(browser);
  expect((await visitor.request.get(`/api/media/${id}`)).status()).toBe(401);
  expect(
    (
      await visitor.request.post('/api/media?kind=photo', {
        headers: { origin: ORIGIN },
        data: PNG,
      })
    ).status(),
  ).toBe(401);
  await visitor.close();

  // The signed-in browser's cookies, from a page of another origin: a write is refused, and so is one with no origin at all.
  const foreign = await page.request.post('/api/media?kind=photo', {
    headers: { origin: 'https://evil.example' },
    data: PNG,
  });
  expect(foreign.status()).toBe(403);
  const none = await page.request.delete(`/api/media/${id}`, { headers: { origin: '' } });
  expect(none.status()).toBe(403);
  expect((await page.request.get(`/api/media/${id}`)).status()).toBe(200);
});
