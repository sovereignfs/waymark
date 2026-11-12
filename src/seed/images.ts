import { createHash } from 'node:crypto';
import sharp from 'sharp';

/**
 * A picture for a seeded photo (task 16.1): generated, never fetched. A sky, a ground and a couple of shapes in colours taken from the photo's key, so each looks different, the same key
 * always looks the same, and the seed needs no picture files and no network. A JPEG, as a phone makes, so the store's own checks and re-encoding are exercised.
 */
export async function pictureOf(key: string): Promise<Buffer> {
  const bytes = createHash('sha256').update(`waymark-seed:picture:${key}`).digest();
  const hue = (i: number) => Math.floor(((bytes[i] ?? 0) / 255) * 360);
  const colour = (i: number, s: number, l: number) => `hsl(${hue(i)} ${s}% ${l}%)`;
  const width = 960;
  const height = 720;
  const horizon = 300 + ((bytes[3] ?? 0) % 160);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
  <defs><linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="${colour(0, 70, 62)}"/><stop offset="1" stop-color="${colour(1, 80, 82)}"/></linearGradient></defs>
  <rect width="${width}" height="${horizon}" fill="url(#sky)"/>
  <rect y="${horizon}" width="${width}" height="${height - horizon}" fill="${colour(2, 45, 34)}"/>
  <circle cx="${120 + ((bytes[4] ?? 0) / 255) * 720}" cy="${90 + ((bytes[5] ?? 0) % 120)}" r="${40 + ((bytes[6] ?? 0) % 40)}" fill="${colour(7, 90, 88)}"/>
  <polygon points="0,${horizon} ${200 + (bytes[8] ?? 0)},${horizon - 140 - ((bytes[9] ?? 0) % 80)} ${520 + (bytes[10] ?? 0)},${horizon}" fill="${colour(11, 35, 28)}"/>
  <rect x="${80 + ((bytes[12] ?? 0) % 500)}" y="${horizon + 40}" width="220" height="120" rx="12" fill="${colour(13, 55, 52)}"/>
</svg>`;
  return sharp(Buffer.from(svg)).jpeg({ quality: 82 }).toBuffer();
}
