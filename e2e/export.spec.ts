import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { unzipSync } from 'fflate';
import { expect, test } from '@playwright/test';
import { EMAIL, mockPosition, signedIn } from './helpers';

/**
 * Export (DESIGN.md §22), in a real browser: a person checks in, asks for their data in Settings > Data, waits for it to be made, and downloads a ZIP that holds that check-in and its place and nothing
 * with an address in it. A job builds it, so this waits on the page, which looks every few seconds.
 */
test.use({ actionTimeout: 15_000 });
expect.configure({ timeout: 60_000 });

test('asking for an export makes a ZIP of the person’s check-ins, which downloads', async ({
  page,
  context,
}, info) => {
  test.setTimeout(120_000);
  await signedIn(page);
  await mockPosition(context, { latitude: 51.5, longitude: -0.12 });
  const tag = randomUUID().slice(0, 8);
  const place = `Export Corner ${tag}`;
  await page.goto('/checkins?checkin=new');
  const sheet = page.getByRole('dialog', { name: 'Check in' });
  await sheet.getByRole('radio', { name: /New place here/ }).check();
  await sheet.getByLabel('Name of the new place').fill(place);
  await sheet.getByLabel('Note').fill(`exported ${tag}`);
  await sheet.getByRole('button', { name: 'Check in' }).click();
  await expect(sheet).toHaveCount(0);
  // The server has it before the export reads it.
  await expect
    .poll(async () => {
      const reply = await page.request.post('/api/sync', {
        headers: { origin: new URL(page.url()).origin, 'content-type': 'application/json' },
        data: { protocol: 2, outbox: [], cursor: 0, trips: {}, limit: 500 },
      });
      return JSON.stringify(await reply.json()).includes(tag);
    })
    .toBe(true);

  await page.goto('/settings?section=data');
  await page.getByRole('button', { name: 'Export my data' }).click();
  const list = page.getByRole('list', { name: 'Your exports' });
  await expect(list.getByRole('link', { name: 'Download' }).first()).toBeVisible({
    timeout: 90_000,
  });
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    list.getByRole('link', { name: 'Download' }).first().click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/^waymark-export-\d{4}-\d{2}-\d{2}\.zip$/);
  const saved = info.outputPath('export.zip');
  await download.saveAs(saved);
  const zip = unzipSync(new Uint8Array(readFileSync(saved)));
  const document = JSON.parse(Buffer.from(zip['waymark.json'] as Uint8Array).toString('utf8'));
  expect(document).toMatchObject({ format: 'waymark-export', version: 2 });
  expect(document.places.some((p: { name: string }) => p.name === place)).toBe(true);
  expect(document.checkins.some((c: { note?: string }) => c.note === `exported ${tag}`)).toBe(true);
  // No address anywhere in it, the person’s own included.
  expect(JSON.stringify(document)).not.toContain(EMAIL);
  expect(JSON.stringify(document.profile)).not.toContain('@');

  // It can be deleted, and then it is gone.
  await list.getByRole('button', { name: 'Delete' }).first().click();
  await expect(list.getByRole('link', { name: 'Download' })).toHaveCount(0);
});
