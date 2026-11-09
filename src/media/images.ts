import sharp from 'sharp';

/**
 * Re-encoding (DESIGN.md §9.3, §18.3): **no byte a person's phone wrote is stored.** An image is decoded, turned upright by its orientation, and written again as WebP with
 * **every piece of metadata gone** (location, time, device, thumbnail, colour profile's text: `sharp` writes none unless asked), at most 2,560 px on its longer side, and a thumbnail
 * of at most 480 px beside it. Decoding is bounded (`limitInputPixels`), so a file that is small and decodes to a billion pixels is refused and does not take the server's memory.
 */
export const PHOTO_MAX_EDGE = 2560;
export const THUMB_MAX_EDGE = 480;
/** The most pixels a file may decode to: 100 megapixels, more than any phone makes. */
export const MAX_INPUT_PIXELS = 100_000_000;

export class ImageError extends Error {
  override name = 'ImageError';
  constructor(readonly reason: 'unreadable' | 'unsupported' | 'too_large') {
    super(
      reason === 'unsupported'
        ? 'this kind of image cannot be read here'
        : reason === 'too_large'
          ? 'the image is larger than can be handled'
          : 'the file could not be read as an image',
    );
  }
}

export interface Reencoded {
  readonly photo: Buffer;
  readonly thumb: Buffer;
  readonly width: number;
  readonly height: number;
}

/** Re-encodes an image as a photo and a thumbnail. Throws an `ImageError`, and never says what was in the file. */
export async function reencode(input: Uint8Array): Promise<Reencoded> {
  try {
    const source = () => sharp(input, { limitInputPixels: MAX_INPUT_PIXELS, failOn: 'error' });
    // `rotate()` with no argument turns the image upright by its orientation and then drops the tag; no `withMetadata`, so nothing else is kept.
    const photo = await source()
      .rotate()
      .resize({
        width: PHOTO_MAX_EDGE,
        height: PHOTO_MAX_EDGE,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .webp({ quality: 82 })
      .toBuffer({ resolveWithObject: true });
    const thumb = await sharp(photo.data)
      .resize({
        width: THUMB_MAX_EDGE,
        height: THUMB_MAX_EDGE,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .webp({ quality: 72 })
      .toBuffer();
    return { photo: photo.data, thumb, width: photo.info.width, height: photo.info.height };
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (/pixel limit|exceeds/i.test(message)) throw new ImageError('too_large');
    if (/codec|unsupported|heif|compression format|plugin/i.test(message))
      throw new ImageError('unsupported');
    throw new ImageError('unreadable');
  }
}
