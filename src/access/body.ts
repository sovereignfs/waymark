/**
 * A request's body as text, refused when it is longer than `limit` bytes: the length it says is checked first, and the stream is cut off at the limit whatever it said, so
 * that a body that lies about its length costs no more than the limit. `null` when it is too large.
 */
export async function readCapped(request: Request, limit: number): Promise<string | null> {
  const said = Number(request.headers.get('content-length') ?? '0');
  if (Number.isFinite(said) && said > limit) return null;
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}
