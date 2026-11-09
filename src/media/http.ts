import type { MediaKind } from './detect';
import { MAX_FILE_BYTES, type PutResult, type Refusal, SENTENCES } from './service';

/**
 * What the media routes say (DESIGN.md §18.3), shared by the upload and the serving. A refusal is a status, a code and a sentence a person can act on; it never says what was in
 * the file or whose it is.
 */
const STATUS: Readonly<Record<Refusal, number>> = {
  bad_id: 400,
  too_big: 413,
  not_allowed: 415,
  unreadable: 422,
  unsupported: 415,
  image_too_large: 413,
  over_limit: 413,
  id_taken: 404,
};

export const refusal = (reason: Refusal): Response =>
  reason === 'id_taken'
    ? new Response(null, { status: 404 })
    : Response.json(
        { code: reason.toUpperCase(), message: SENTENCES[reason] },
        { status: STATUS[reason] },
      );

export const stored = (result: Extract<PutResult, { ok: true }>): Response =>
  Response.json(
    { id: result.id, thumbId: result.thumbId ?? null, bytes: result.bytes },
    { status: result.existing ? 200 : 201 },
  );

/** The kinds a person may upload (a thumbnail is made by the server). */
export function uploadKind(value: string | null): Exclude<MediaKind, 'thumb'> | undefined {
  return value === 'photo' || value === 'attachment' || value === 'import' ? value : undefined;
}

/**
 * The request's body as bytes, refused when it is more than a file may be: the length it says is checked first, and the stream is cut off at the limit whatever it said, so that
 * a body that lies about its length costs no more than the limit.
 */
export async function bodyOf(request: Request): Promise<Uint8Array | 'too_big'> {
  const said = Number(request.headers.get('content-length') ?? '0');
  if (Number.isFinite(said) && said > MAX_FILE_BYTES) return 'too_big';
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > MAX_FILE_BYTES) {
      await reader.cancel();
      return 'too_big';
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/** The headers a file is served with: the stored type and no other, never sniffed, kept private to the person's browser, and for a PDF a policy that lets nothing in it run. */
export function fileHeaders(type: string): Record<string, string> {
  return {
    'content-type': type,
    'x-content-type-options': 'nosniff',
    'cache-control': 'private, max-age=31536000, immutable',
    'content-disposition':
      type.startsWith('image/') || type === 'application/pdf' ? 'inline' : 'attachment',
    // A file is never a page: nothing in it may run, load or frame, whatever it claims to be.
    'content-security-policy': "default-src 'none'; sandbox",
    'cross-origin-resource-policy': 'same-origin',
  };
}
