import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * **An invitation's token** (DESIGN.md §11.2): 32 random bytes, shown once in the link, and **kept only as its hash**, so that a copy of the database holds nothing that opens a trip. The hash is compared in constant time. A string that is not
 * the shape of a token is not looked up at all.
 */
export const TOKEN_BYTES = 32;
/** 32 bytes as base64url. */
export const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;

export const isToken = (value: unknown): value is string =>
  typeof value === 'string' && TOKEN_SHAPE.test(value);

export const hashToken = (token: string): string =>
  createHash('sha256').update(token, 'utf8').digest('hex');

export function newToken(): { token: string; hash: string } {
  const token = randomBytes(TOKEN_BYTES).toString('base64url');
  return { token, hash: hashToken(token) };
}

/** Whether a stored hash is the token's, in constant time. */
export function sameHash(stored: string, token: string): boolean {
  const a = Buffer.from(stored, 'hex');
  const b = Buffer.from(hashToken(token), 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The ways an invitation stops being usable. */
export const INVITE_TTL_MS = 14 * 24 * 3_600_000;
/** An invitation is sent again at most this often. */
export const RESEND_AFTER_MS = 3_600_000;
/** The most invitations a trip holds that are waiting. */
export const MAX_PENDING = 50;
