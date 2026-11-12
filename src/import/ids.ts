import { createHash } from 'node:crypto';

/** What a made id is for. */
export type IdKind =
  | 'place'
  | 'checkin'
  | 'photo'
  | 'trip'
  | 'tripplace'
  | 'stop'
  | 'day'
  | 'item'
  | 'link'
  | 'attachment'
  | 'attachmentfile';

/** A UUID made from what a thing is, so that making it again makes the same id (and the id is a valid one for a row and a file name). */
export function idFor(kind: IdKind, accountId: string, key: string): string {
  const hash = createHash('sha256').update(`waymark:import:${kind}:${accountId}:${key}`).digest();
  const hex = hash.subarray(0, 16).toString('hex').split('');
  hex[12] = '8';
  hex[16] = ['8', '9', 'a', 'b'][(hash[8] ?? 0) & 3] ?? '8';
  const h = hex.join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}
