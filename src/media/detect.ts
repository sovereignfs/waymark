/**
 * **A file is judged by its bytes, never by its name or the type it was sent with** (DESIGN.md §18.3, §25 Security): an HTML page named `.jpg` is HTML. The allow-list is per
 * kind of file, and what is not on it is refused before anything is decoded or stored.
 *
 *   photo       an image: JPEG, PNG, WebP, GIF, AVIF, HEIC (§9.3)
 *   attachment  an image, or a PDF (§10.6)
 *   import      a ZIP, the Swarm export (§16)
 *
 * (A `thumb` is made by the server and is WebP.) Magic numbers are the first bytes of each format.
 */
export type MediaKind = 'photo' | 'thumb' | 'attachment' | 'import';
export type Detected = 'jpeg' | 'png' | 'webp' | 'gif' | 'avif' | 'heic' | 'pdf' | 'zip';

export const MEDIA_KINDS: readonly MediaKind[] = ['photo', 'thumb', 'attachment', 'import'];

/** What a person may upload, by kind: a `thumb` is never uploaded. */
export const UPLOADABLE: Readonly<Record<MediaKind, readonly Detected[]>> = {
  photo: ['jpeg', 'png', 'webp', 'gif', 'avif', 'heic'],
  attachment: ['jpeg', 'png', 'webp', 'gif', 'avif', 'heic', 'pdf'],
  import: ['zip'],
  thumb: [],
};

/** The MIME type each kind of file is served with, which is the one stored and not the one the uploader said. */
export const MIME: Readonly<Record<Detected, string>> = {
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
  avif: 'image/avif',
  heic: 'image/heic',
  pdf: 'application/pdf',
  zip: 'application/zip',
};

const startsWith = (bytes: Uint8Array, signature: readonly number[], at = 0) =>
  signature.every((byte, index) => bytes[at + index] === byte);

const ascii = (bytes: Uint8Array, from: number, to: number) =>
  Buffer.from(bytes.subarray(from, to)).toString('latin1');

/** The format of `bytes`, from its first bytes alone, or `undefined` when it is none the app knows. */
export function detect(bytes: Uint8Array): Detected | undefined {
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'jpeg';
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png';
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 12) === 'WEBP') return 'webp';
  if (ascii(bytes, 0, 6) === 'GIF87a' || ascii(bytes, 0, 6) === 'GIF89a') return 'gif';
  if (ascii(bytes, 0, 5) === '%PDF-') return 'pdf';
  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])) return 'zip';
  // ISO base media (HEIC and AVIF): a box of the type `ftyp` at byte 4, then the major brand.
  if (ascii(bytes, 4, 8) === 'ftyp') {
    const brand = ascii(bytes, 8, 12);
    if (brand === 'avif' || brand === 'avis') return 'avif';
    if (['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1'].includes(brand))
      return 'heic';
  }
  return undefined;
}

/** Whether a kind of file may be uploaded as what its bytes are. */
export const allowed = (kind: MediaKind, detected: Detected | undefined): detected is Detected =>
  detected !== undefined && UPLOADABLE[kind].includes(detected);
