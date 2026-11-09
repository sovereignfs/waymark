import { createHash } from 'node:crypto';

/**
 * The instance key (DESIGN.md §18.1): `WAYMARK_ENCRYPTION_KEY`, 32 random bytes, which wraps the data key of every sealed row and file and seals the
 * credentials the app keeps (core's refresh token). It is read as base64, URL-safe base64 or hex, and **known by a fingerprint**, never by its value: a
 * fingerprint is what a log, an error and the database say of a key. The fingerprint is domain-separated, a hash of the key under a name of its own, so
 * that it is not a hash of the key that anything else makes. Node's `crypto` only, on the server. Copied from Tusk.
 */
export const KEY_BYTES = 32;

export interface KeyEntry {
  readonly key: Buffer;
  readonly fingerprint: string;
}

/** The key sealing is done with, and the one that was in use before it while credentials sealed under it are being moved to the new one. */
export interface KeyRing {
  readonly current: KeyEntry;
  readonly previous?: KeyEntry;
}

const HEX = /^[0-9a-fA-F]{64}$/;
const BASE64 = /^[A-Za-z0-9+/_-]+={0,2}$/;

/** Reads a key in any of its three forms, or says nothing: what is wrong with it is not said, since what was given is a secret. */
export function parseKey(text: string): Buffer | undefined {
  const value = text.trim();
  // A key of 32 bytes is 64 hex characters, which are also valid base64 (of 48 bytes): hex is tried first, and only it is that long.
  if (HEX.test(value)) return Buffer.from(value, 'hex');
  if (!BASE64.test(value)) return undefined;
  const bytes = Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  return bytes.length === KEY_BYTES ? bytes : undefined;
}

/** A short name for a key that is safe to show: 16 hex characters of a hash of the key under this name. */
export function fingerprintOf(key: Buffer): string {
  return createHash('sha256')
    .update('waymark:encryption-key:fingerprint:v1\0')
    .update(key)
    .digest('hex')
    .slice(0, 16);
}

export function entryOf(key: Buffer): KeyEntry {
  return { key, fingerprint: fingerprintOf(key) };
}

/** The ring for a current key and, while one is being retired, the previous. `undefined` when there is no current key. */
export function ringOf(current: Buffer | undefined, previous?: Buffer): KeyRing | undefined {
  if (!current) return undefined;
  return { current: entryOf(current), ...(previous ? { previous: entryOf(previous) } : {}) };
}
