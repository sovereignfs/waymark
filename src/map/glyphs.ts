import { readFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * The map's glyphs, the fonts' letters as MapLibre draws them (DESIGN.md §8.1): **Latin, Greek, Cyrillic and general punctuation, bundled in the image** (`src/map/assets/fonts`, Noto Sans
 * Regular and Bold, SIL Open Font License 1.1, taken from OpenFreeMap's build), 1.2 MB in all, so that a map with the source `pmtiles` or an upstream that is down still has its labels. Any
 * other range (Chinese, Japanese, Arabic, …) is fetched from the default upstream and cached when the source is `proxy`, and is absent otherwise, so labels in those scripts show their Latin name,
 * which the style prefers. The style uses only the two fonts below, and a request for another is not found.
 */
export const FONTS = ['Noto Sans Regular', 'Noto Sans Bold'] as const;
export type Font = (typeof FONTS)[number];

/** `0-255`: the range's start is a multiple of 256, and its end is 255 more. */
export function parseRange(range: string): { start: number; end: number } | undefined {
  const match = /^(\d{1,5})-(\d{1,5})\.pbf$/.exec(range);
  if (!match) return undefined;
  const start = Number(match[1]);
  const end = Number(match[2]);
  return start % 256 === 0 && end === start + 255 && end <= 65535 ? { start, end } : undefined;
}

/** A font stack as the style asks for it, which is one name, and one of ours. */
export function parseFont(fontstack: string): Font | undefined {
  return (FONTS as readonly string[]).includes(fontstack) ? (fontstack as Font) : undefined;
}

/** Where the bundled glyphs are: beside the server's files (`src/map/assets`, which the build keeps), relative to the working directory the server is started in. */
export const bundledDir = (root: string = process.cwd()) =>
  path.join(root, 'src', 'map', 'assets', 'fonts');

/** A bundled range, or undefined if it is not one of those the image has. */
export async function bundled(dir: string, font: Font, range: string): Promise<Buffer | undefined> {
  try {
    return await readFile(path.join(dir, font, range));
  } catch {
    return undefined;
  }
}
