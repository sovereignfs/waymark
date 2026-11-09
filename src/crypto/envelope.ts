import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { type KeyEntry, type KeyRing, KEY_BYTES } from './keys';

/**
 * Envelope encryption (DESIGN.md §18.1): **AES-256-GCM with a random data key for each credential, row or file, and the data key wrapped under the
 * instance key.** Two forms of one envelope, copied from Tusk and extended: the text form (`seal`, `open`), for a credential kept as text, and the **binary form**
 * (`sealBytes`, `openBytes`), which is what a `sealed` column and a sealed file hold (`src/crypto/sealed.ts` is the one place that makes a row's). A value is sealed to the row and purpose it belongs to: **both are in the authenticated data of both layers**, and the wrapping's also names the key,
 * so a sealed value moved to another row or used for another purpose does not open, and neither does one whose wrapping was re-labelled with another key.
 * Rotation moves only the wrapping (`rewrap`), so the payload, and the key that made it, are never seen together by anything but `open`.
 *
 * The form is `t1.<key fingerprint>.<wrapped data key>.<payload>`, each part base64url. Nothing here logs, and **an error says what kind of failure it was and
 * never a value**: not the secret, not the key, not the binding.
 */
export interface Binding {
  /** The row it is kept in. */
  readonly id: string;
  /** What it is for, e.g. `github-token`. */
  readonly purpose: string;
}

export type CryptoFailure = 'malformed' | 'unknown_key' | 'cannot_open';

export class CryptoError extends Error {
  constructor(
    readonly failure: CryptoFailure,
    /** The fingerprint of a key that is not known, for the message that names it. */
    readonly fingerprint?: string,
  ) {
    super(
      failure === 'unknown_key'
        ? `something is sealed under a key (${fingerprint ?? 'unknown'}) that this server does not have`
        : failure === 'malformed'
          ? 'a sealed value is not in the form this server writes'
          : 'a sealed value could not be opened',
    );
    this.name = 'CryptoError';
  }
}

const VERSION = 't1';
const IV_BYTES = 12;
const TAG_BYTES = 16;

const b64 = (bytes: Buffer) => bytes.toString('base64url');
const unb64 = (text: string) => Buffer.from(text, 'base64url');

/** The authenticated data of the payload: what the value is, and where it is kept. (Exported for the tests, which hold each binding to its layer.) */
export const payloadAad = (b: Binding) =>
  Buffer.from(`waymark:credential:data:v1|${b.purpose}|${b.id}`);
/** The authenticated data of the wrapping: the same, and the key that wraps it. */
export const wrapAad = (b: Binding, fingerprint: string) =>
  Buffer.from(`waymark:credential:wrap:v1|${b.purpose}|${b.id}|${fingerprint}`);

export function encrypt(key: Buffer, plain: Buffer, aad: Buffer): Buffer {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(aad);
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([iv, body, cipher.getAuthTag()]);
}

export function decrypt(key: Buffer, packed: Buffer, aad: Buffer): Buffer {
  if (packed.length < IV_BYTES + TAG_BYTES) throw new CryptoError('malformed');
  const decipher = createDecipheriv('aes-256-gcm', key, packed.subarray(0, IV_BYTES));
  decipher.setAAD(aad);
  decipher.setAuthTag(packed.subarray(packed.length - TAG_BYTES));
  try {
    return Buffer.concat([
      decipher.update(packed.subarray(IV_BYTES, packed.length - TAG_BYTES)),
      decipher.final(),
    ]);
  } catch {
    throw new CryptoError('cannot_open');
  }
}

/** Seals `plain` to `binding`, under the current key. */
export function seal(plain: string, binding: Binding, current: KeyEntry): string {
  const dataKey = randomBytes(KEY_BYTES);
  const wrapped = encrypt(current.key, dataKey, wrapAad(binding, current.fingerprint));
  const payload = encrypt(dataKey, Buffer.from(plain, 'utf8'), payloadAad(binding));
  dataKey.fill(0);
  return [VERSION, current.fingerprint, b64(wrapped), b64(payload)].join('.');
}

function parts(sealed: string): { fingerprint: string; wrapped: Buffer; payload: Buffer } {
  const split = sealed.split('.');
  if (split.length !== 4 || split[0] !== VERSION || !/^[0-9a-f]{16}$/.test(split[1] ?? ''))
    throw new CryptoError('malformed');
  return {
    fingerprint: split[1] as string,
    wrapped: unb64(split[2] ?? ''),
    payload: unb64(split[3] ?? ''),
  };
}

/** The fingerprint of the key a sealed value is wrapped under: what the database keeps beside it, to know which rows a key stands for. */
export function fingerprintOfSealed(sealed: string): string | undefined {
  try {
    return parts(sealed).fingerprint;
  } catch {
    return undefined;
  }
}

function keyFor(ring: KeyRing, fingerprint: string): KeyEntry {
  for (const entry of [ring.current, ring.previous])
    if (entry && entry.fingerprint === fingerprint) return entry;
  throw new CryptoError('unknown_key', fingerprint);
}

/** Opens a sealed value for the row and purpose it was sealed to, with the key it names, which must be in the ring. */
export function open(sealed: string, binding: Binding, ring: KeyRing): string {
  const { fingerprint, wrapped, payload } = parts(sealed);
  const entry = keyFor(ring, fingerprint);
  const dataKey = decrypt(entry.key, wrapped, wrapAad(binding, fingerprint));
  try {
    return decrypt(dataKey, payload, payloadAad(binding)).toString('utf8');
  } finally {
    dataKey.fill(0);
  }
}

/**
 * Moves a sealed value to another key: the data key is opened under `from` and wrapped again under `to`, bound to the same row and purpose, and **the
 * payload is untouched**. The result names `to`.
 */
export function rewrap(sealed: string, binding: Binding, from: KeyEntry, to: KeyEntry): string {
  const { fingerprint, wrapped, payload } = parts(sealed);
  if (fingerprint !== from.fingerprint) throw new CryptoError('unknown_key', fingerprint);
  const dataKey = decrypt(from.key, wrapped, wrapAad(binding, fingerprint));
  try {
    const again = encrypt(to.key, dataKey, wrapAad(binding, to.fingerprint));
    return [VERSION, to.fingerprint, b64(again), b64(payload)].join('.');
  } finally {
    dataKey.fill(0);
  }
}

/**
 * The binary form (DESIGN.md §24.2, `sealed`): `0x01`, the key's fingerprint as 8 bytes, the wrapped data key's length as a big-endian 16-bit number, the wrapped
 * data key, and the payload. The same two layers and the same binding as the text form, in the authenticated data of both, with a domain of its own so that a text
 * value cannot be presented as a row.
 */
const BINARY_VERSION = 0x01;
const FINGERPRINT_BYTES = 8;
const HEADER_BYTES = 1 + FINGERPRINT_BYTES + 2;

/** The authenticated data of each layer of the binary form (exported for the tests, which hold each binding to its layer). */
export const rowPayloadAad = (b: Binding) =>
  Buffer.from(`waymark:sealed:data:v1|${b.purpose}|${b.id}`);
export const rowWrapAad = (b: Binding, fingerprint: string) =>
  Buffer.from(`waymark:sealed:wrap:v1|${b.purpose}|${b.id}|${fingerprint}`);

export function binaryParts(envelope: Uint8Array): {
  fingerprint: string;
  wrapped: Buffer;
  payload: Buffer;
} {
  const bytes = Buffer.from(envelope.buffer, envelope.byteOffset, envelope.byteLength);
  if (bytes.length < HEADER_BYTES || bytes[0] !== BINARY_VERSION)
    throw new CryptoError('malformed');
  const length = bytes.readUInt16BE(1 + FINGERPRINT_BYTES);
  const end = HEADER_BYTES + length;
  if (length === 0 || bytes.length <= end) throw new CryptoError('malformed');
  return {
    fingerprint: bytes.subarray(1, 1 + FINGERPRINT_BYTES).toString('hex'),
    wrapped: bytes.subarray(HEADER_BYTES, end),
    payload: bytes.subarray(end),
  };
}

function assemble(fingerprint: string, wrapped: Buffer, payload: Buffer): Buffer {
  const head = Buffer.alloc(HEADER_BYTES);
  head[0] = BINARY_VERSION;
  Buffer.from(fingerprint, 'hex').copy(head, 1);
  head.writeUInt16BE(wrapped.length, 1 + FINGERPRINT_BYTES);
  return Buffer.concat([head, wrapped, payload]);
}

/** Seals bytes to `binding` (a row's id and its table, or a file's id and its kind), under the current key, as the binary form. */
export function sealBytes(plain: Uint8Array, binding: Binding, current: KeyEntry): Buffer {
  const dataKey = randomBytes(KEY_BYTES);
  try {
    const wrapped = encrypt(current.key, dataKey, rowWrapAad(binding, current.fingerprint));
    const payload = encrypt(dataKey, Buffer.from(plain), rowPayloadAad(binding));
    return assemble(current.fingerprint, wrapped, payload);
  } finally {
    dataKey.fill(0);
  }
}

/** The fingerprint of the key a binary envelope is wrapped under, or undefined if it is not one. */
export function fingerprintOfEnvelope(envelope: Uint8Array): string | undefined {
  try {
    return binaryParts(envelope).fingerprint;
  } catch {
    return undefined;
  }
}

/** Opens a binary envelope for the row or file it was sealed to, with the key it names, which must be in the ring. */
export function openBytes(envelope: Uint8Array, binding: Binding, ring: KeyRing): Buffer {
  const { fingerprint, wrapped, payload } = binaryParts(envelope);
  const entry = keyFor(ring, fingerprint);
  const dataKey = decrypt(entry.key, wrapped, rowWrapAad(binding, fingerprint));
  try {
    return decrypt(dataKey, payload, rowPayloadAad(binding));
  } finally {
    dataKey.fill(0);
  }
}

/** Moves a binary envelope to another key: only the data key is wrapped again, bound to the same row, and the payload is untouched. */
export function rewrapBytes(
  envelope: Uint8Array,
  binding: Binding,
  from: KeyEntry,
  to: KeyEntry,
): Buffer {
  const { fingerprint, wrapped, payload } = binaryParts(envelope);
  if (fingerprint !== from.fingerprint) throw new CryptoError('unknown_key', fingerprint);
  const dataKey = decrypt(from.key, wrapped, rowWrapAad(binding, fingerprint));
  try {
    return assemble(
      to.fingerprint,
      encrypt(to.key, dataKey, rowWrapAad(binding, to.fingerprint)),
      payload,
    );
  } finally {
    dataKey.fill(0);
  }
}
