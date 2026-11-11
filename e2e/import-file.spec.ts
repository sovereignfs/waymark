import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { ZipWriter } from '../src/portability/zip';
import { signedIn } from './helpers';

/**
 * Importing a Waymark file (DESIGN.md §22), in a real browser: a file is chosen in Settings > Data, a job reads it, and its check-ins are in the timeline; the same file again makes nothing; a file that is not right is
 * refused with a sentence. The file is built here the way Export builds it (`format.ts` says what is in it).
 */
test.use({ actionTimeout: 15_000 });
expect.configure({ timeout: 60_000 });

function waymarkFile(tag: string, count: number, over: Record<string, unknown> = {}): Buffer {
  const place = {
    id: `p-${tag}`,
    name: `Import Place ${tag}`,
    lat: 38.7,
    lng: -9.1,
    source: 'manual',
    tz: 'Europe/Lisbon',
    countryCode: null,
  };
  const checkins = Array.from({ length: count }, (_, i) => ({
    id: `c-${tag}-${i}`,
    placeId: place.id,
    at: 1_700_000_000_000 + i * 3_600_000,
    tz: 'Europe/Lisbon',
    offsetMin: 0,
    note: `imported ${tag} ${i}`,
    companions: [],
    tripId: null,
    linkSource: null,
    share: 'trip',
    source: 'manual',
  }));
  const document = {
    format: 'waymark-export',
    version: 1,
    exportedAt: new Date().toISOString(),
    profile: { name: 'Someone Else', units: 'km', weekStart: 1, shareDefault: 'ask' },
    settings: { email: {} },
    places: [place],
    checkins,
    photos: [],
    ...over,
  };
  const zip = new ZipWriter(new Date());
  const out: Buffer[] = [];
  for (const part of zip.add('waymark.json', Buffer.from(JSON.stringify(document)), {
    deflate: true,
  }))
    out.push(part);
  for (const part of zip.finish()) out.push(part);
  return Buffer.concat(out);
}

test('a Waymark file is imported, once, and a file that is not right is refused', async ({
  page,
}) => {
  test.setTimeout(150_000);
  await signedIn(page);
  const tag = randomUUID().slice(0, 8);
  await page.goto('/settings?section=data');
  const chooser = page.getByLabel('A Waymark export file');

  // A file that is not one is refused with a sentence, and nothing is made.
  await chooser.setInputFiles({
    name: 'nope.zip',
    mimeType: 'application/zip',
    buffer: Buffer.from('this is not a zip'),
  });
  await expect(page.getByRole('status').filter({ hasText: /not a Waymark export/ })).toBeVisible({
    timeout: 90_000,
  });

  // A file from a newer version is refused and says what to do.
  await chooser.setInputFiles({
    name: 'newer.zip',
    mimeType: 'application/zip',
    buffer: waymarkFile(tag, 1, { version: 99 }),
  });
  await expect(
    page.getByRole('status').filter({ hasText: /newer version of Waymark/ }),
  ).toBeVisible({ timeout: 90_000 });

  // A good one is imported.
  await chooser.setInputFiles({
    name: 'good.zip',
    mimeType: 'application/zip',
    buffer: waymarkFile(tag, 3),
  });
  await expect(
    page.getByRole('status').filter({ hasText: /Imported: 3 check-ins and 1 places/ }),
  ).toBeVisible({ timeout: 90_000 });
  await page.goto('/checkins');
  await page.getByRole('searchbox', { name: 'Search' }).fill(`imported ${tag}`);
  await expect(page.getByRole('list', { name: 'Check-ins' }).getByRole('link')).toHaveCount(3);

  // The same file again makes nothing.
  await page.goto('/settings?section=data');
  await page
    .getByLabel('A Waymark export file')
    .setInputFiles({ name: 'good.zip', mimeType: 'application/zip', buffer: waymarkFile(tag, 3) });
  await expect(
    page
      .getByRole('status')
      .filter({ hasText: /Imported: 0 check-ins and 0 places, 3 already here/ }),
  ).toBeVisible({ timeout: 90_000 });
  await page.goto('/checkins');
  await page.getByRole('searchbox', { name: 'Search' }).fill(`imported ${tag}`);
  await expect(page.getByRole('list', { name: 'Check-ins' }).getByRole('link')).toHaveCount(3);
});
