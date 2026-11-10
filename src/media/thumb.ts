/**
 * The id of a photo's thumbnail, worked out **on the device** (DESIGN.md §9.3): it is derived from the photo's id, so a device that knows the photo knows its thumbnail without asking. **The same
 * derivation as the server's `thumbIdOf` (`files.ts`)**, which needs Node's `createHash`; this one uses the Web Crypto every browser and Node have, so the timeline can ask `/api/media/<thumb id>` for
 * a list of photos and the full image only for the one a person opens. `thumb.test.ts` holds the two equal.
 */
export async function thumbIdAsync(photoId: string): Promise<string> {
  const bytes = new TextEncoder().encode(`waymark:thumb:${photoId}`);
  const hash = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes));
  const hex = [...hash.subarray(0, 16)].map((b) => b.toString(16).padStart(2, '0'));
  // A UUID's version and variant, so that it is one.
  hex[6] = `${'8'}${hex[6]?.slice(1) ?? '0'}`;
  hex[8] = `${['8', '9', 'a', 'b'][(hash[8] ?? 0) & 3] ?? '8'}${hex[8]?.slice(1) ?? '0'}`;
  const h = hex.join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}
