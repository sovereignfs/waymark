import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  CryptoError,
  binaryParts,
  decrypt,
  encrypt,
  fingerprintOfEnvelope,
  fingerprintOfSealed,
  open,
  openBytes,
  payloadAad,
  rewrap,
  rewrapBytes,
  rowPayloadAad,
  rowWrapAad,
  seal,
  sealBytes,
  wrapAad,
} from './envelope';
import { entryOf, fingerprintOf, parseKey, ringOf } from './keys';

/**
 * Envelope encryption of a credential (DESIGN.md §21.2): sealed to its row and purpose, wrapped under the instance key, moved between keys without its
 * payload being touched, and never saying a value when it fails.
 */
const KEY = entryOf(randomBytes(32));
const OTHER = entryOf(randomBytes(32));
const must = <T>(value: T | undefined): T => {
  if (value === undefined) throw new Error('no ring');
  return value;
};
const ring = must(ringOf(KEY.key));
const SECRET = 'github_pat_PLANTED-SECRET-VALUE';
const here = { id: 'cred-1', purpose: 'github-token' };

const failure = (fn: () => unknown): CryptoError => {
  try {
    fn();
  } catch (error) {
    if (error instanceof CryptoError) return error;
    throw error;
  }
  throw new Error('it did not fail');
};

describe('keys', () => {
  it('are read in base64, URL-safe base64 and hex, of 32 bytes and no other length, with no word of what was given', () => {
    const bytes = randomBytes(32);
    expect(parseKey(bytes.toString('base64'))?.equals(bytes)).toBe(true);
    expect(parseKey(bytes.toString('base64url'))?.equals(bytes)).toBe(true);
    expect(parseKey(bytes.toString('hex'))?.equals(bytes)).toBe(true);
    expect(parseKey(`  ${bytes.toString('hex')}\n`)?.equals(bytes)).toBe(true);
    for (const wrong of [
      '',
      'short',
      randomBytes(31).toString('base64'),
      randomBytes(33).toString('hex'),
      'not base64 at all!',
      '!'.repeat(44),
    ])
      expect(parseKey(wrong), wrong).toBeUndefined();
  });

  it('are known by a fingerprint that is stable, differs for another key, and is not a plain hash of the key', async () => {
    const bytes = randomBytes(32);
    expect(fingerprintOf(bytes)).toBe(fingerprintOf(Buffer.from(bytes)));
    expect(fingerprintOf(bytes)).toMatch(/^[0-9a-f]{16}$/);
    expect(fingerprintOf(bytes)).not.toBe(fingerprintOf(randomBytes(32)));
    const { createHash } = await import('node:crypto');
    expect(fingerprintOf(bytes)).not.toBe(
      createHash('sha256').update(bytes).digest('hex').slice(0, 16),
    );
    expect(fingerprintOf(bytes)).not.toContain(bytes.toString('hex').slice(0, 8));
  });
});

describe('sealing', () => {
  it('opens what it sealed, for the row and purpose it was sealed to, and is different each time', () => {
    const a = seal(SECRET, here, KEY);
    const b = seal(SECRET, here, KEY);
    expect(open(a, here, ring)).toBe(SECRET);
    expect(a).not.toBe(b);
    expect(a).not.toContain(SECRET);
    expect(a.startsWith(`t1.${KEY.fingerprint}.`)).toBe(true);
    expect(fingerprintOfSealed(a)).toBe(KEY.fingerprint);
    expect(open(seal('', here, KEY), here, ring)).toBe('');
    expect(open(seal('naïve — 日本語 🔐', here, KEY), here, ring)).toBe('naïve — 日本語 🔐');
  });

  it('does not open for another row, or another purpose', () => {
    const sealed = seal(SECRET, here, KEY);
    expect(failure(() => open(sealed, { ...here, id: 'cred-2' }, ring)).failure).toBe(
      'cannot_open',
    );
    expect(failure(() => open(sealed, { ...here, purpose: 'other' }, ring)).failure).toBe(
      'cannot_open',
    );
    // The two are not run together: an id ending where a purpose begins is not the same binding.
    const a = seal(SECRET, { id: 'ab', purpose: 'c' }, KEY);
    expect(failure(() => open(a, { id: 'a', purpose: 'bc' }, ring)).failure).toBe('cannot_open');
  });

  it('does not open under a key it does not name, and says which one it wants and never the key', () => {
    const sealed = seal(SECRET, here, KEY);
    const error = failure(() => open(sealed, here, must(ringOf(OTHER.key))));
    expect(error.failure).toBe('unknown_key');
    expect(error.message).toContain(KEY.fingerprint);
    expect(error.message).not.toContain(KEY.key.toString('hex'));
  });

  it('does not open if any part is changed: the wrapping, the payload, the key it names, or the form', () => {
    const [v, fp, wrapped, payload] = seal(SECRET, here, KEY).split('.') as [
      string,
      string,
      string,
      string,
    ];
    const flip = (text: string) =>
      `${text.slice(0, 4)}${text[4] === 'A' ? 'B' : 'A'}${text.slice(5)}`;
    expect(failure(() => open([v, fp, flip(wrapped), payload].join('.'), here, ring)).failure).toBe(
      'cannot_open',
    );
    expect(failure(() => open([v, fp, wrapped, flip(payload)].join('.'), here, ring)).failure).toBe(
      'cannot_open',
    );
    // Another credential's payload under this one's wrapping.
    const other = seal('another secret', here, KEY).split('.');
    expect(failure(() => open([v, fp, wrapped, other[3]].join('.'), here, ring)).failure).toBe(
      'cannot_open',
    );
    // Re-labelled with another key's fingerprint, so that it is read under the wrong key: the wrapping names its key.
    const both = must(ringOf(KEY.key, OTHER.key));
    expect(
      failure(() => open([v, OTHER.fingerprint, wrapped, payload].join('.'), here, both)).failure,
    ).toBe('cannot_open');
    for (const malformed of [
      '',
      'x',
      't1.a.b.c',
      `t2.${fp}.${wrapped}.${payload}`,
      `t1.${fp}.${wrapped}`,
      `t1.${fp}.${wrapped}.${payload}.extra`,
      `t1.${fp}..`,
    ])
      expect(failure(() => open(malformed, here, ring)).failure, malformed).toBe('malformed');
    expect(fingerprintOfSealed('not sealed')).toBeUndefined();
  });

  it('never has the secret, the key or the binding in what it says when it fails', () => {
    const sealed = seal(SECRET, here, KEY);
    for (const error of [
      failure(() => open(sealed, { ...here, id: 'cred-2' }, ring)),
      failure(() => open(sealed, here, must(ringOf(OTHER.key)))),
      failure(() => open('garbage', here, ring)),
    ])
      for (const secret of [
        SECRET,
        KEY.key.toString('hex'),
        KEY.key.toString('base64'),
        here.id,
        here.purpose,
      ])
        expect(`${error.message} ${error.stack}`, secret).not.toContain(secret);
  });
});

describe('moving to another key', () => {
  it('opens the same value under the new key alone, and does not under the old, with the payload untouched', () => {
    const sealed = seal(SECRET, here, KEY);
    const moved = rewrap(sealed, here, KEY, OTHER);
    expect(fingerprintOfSealed(moved)).toBe(OTHER.fingerprint);
    expect(open(moved, here, must(ringOf(OTHER.key)))).toBe(SECRET);
    expect(failure(() => open(moved, here, ring)).failure).toBe('unknown_key');
    expect(moved.split('.')[3]).toBe(sealed.split('.')[3]);
    expect(moved.split('.')[2]).not.toBe(sealed.split('.')[2]);
    // Either key is enough while both are in the ring.
    expect(open(sealed, here, must(ringOf(OTHER.key, KEY.key)))).toBe(SECRET);
    expect(open(moved, here, must(ringOf(OTHER.key, KEY.key)))).toBe(SECRET);
  });

  it('keeps the binding: a moved value still does not open for another row, and a value of another key is not moved', () => {
    const moved = rewrap(seal(SECRET, here, KEY), here, KEY, OTHER);
    expect(
      failure(() => open(moved, { ...here, id: 'cred-2' }, must(ringOf(OTHER.key)))).failure,
    ).toBe('cannot_open');
    expect(failure(() => rewrap(seal(SECRET, here, KEY), here, OTHER, KEY)).failure).toBe(
      'unknown_key',
    );
    // Moved as another row, it is refused: the wrapping is opened under the binding it was made with.
    expect(
      failure(() => rewrap(seal(SECRET, here, KEY), { ...here, id: 'cred-2' }, KEY, OTHER)).failure,
    ).toBe('cannot_open');
  });
});

/**
 * Each binding, held to its own layer. A moved value is refused at the wrapping first, so these try each layer alone: with a binding removed from the
 * authenticated data of one layer, only its test here can still see it.
 */
describe('each layer is bound to what it is for', () => {
  const dataKey = randomBytes(32);
  const plain = Buffer.from('a data key or a secret');
  const refused = (fn: () => unknown) => failure(fn).failure === 'cannot_open';

  it('the payload to its row, and to its purpose', () => {
    const packed = encrypt(dataKey, plain, payloadAad(here));
    expect(decrypt(dataKey, packed, payloadAad(here)).equals(plain)).toBe(true);
    expect(refused(() => decrypt(dataKey, packed, payloadAad({ ...here, id: 'cred-2' })))).toBe(
      true,
    );
    expect(refused(() => decrypt(dataKey, packed, payloadAad({ ...here, purpose: 'other' })))).toBe(
      true,
    );
  });

  it('the wrapping to its row, to its purpose, and to the key that wraps it', () => {
    const packed = encrypt(KEY.key, dataKey, wrapAad(here, KEY.fingerprint));
    expect(decrypt(KEY.key, packed, wrapAad(here, KEY.fingerprint)).equals(dataKey)).toBe(true);
    expect(
      refused(() => decrypt(KEY.key, packed, wrapAad({ ...here, id: 'cred-2' }, KEY.fingerprint))),
    ).toBe(true);
    expect(
      refused(() =>
        decrypt(KEY.key, packed, wrapAad({ ...here, purpose: 'other' }, KEY.fingerprint)),
      ),
    ).toBe(true);
    expect(refused(() => decrypt(KEY.key, packed, wrapAad(here, OTHER.fingerprint)))).toBe(true);
  });

  it('the two layers are not each other’s: a payload does not open as a wrapping, nor a wrapping as a payload', () => {
    const asPayload = encrypt(dataKey, plain, payloadAad(here));
    expect(refused(() => decrypt(dataKey, asPayload, wrapAad(here, KEY.fingerprint)))).toBe(true);
    const asWrap = encrypt(dataKey, plain, wrapAad(here, KEY.fingerprint));
    expect(refused(() => decrypt(dataKey, asWrap, payloadAad(here)))).toBe(true);
  });
});

describe('the binary form, which a sealed column and a sealed file hold', () => {
  const row = { id: 'row-1', purpose: 'place' };
  const plain = Buffer.from('{"name":"PLANTED-PLACE-NAME"}');

  it('opens for the row it was sealed to, and is not the text that was sealed', () => {
    const envelope = sealBytes(plain, row, KEY);
    expect(openBytes(envelope, row, ring).equals(plain)).toBe(true);
    expect(envelope.includes(plain)).toBe(false);
    expect(envelope.toString('latin1')).not.toContain('PLANTED');
    expect(fingerprintOfEnvelope(envelope)).toBe(KEY.fingerprint);
  });

  it('is new each time: a new data key and a new nonce, so that two equal rows do not look equal', () => {
    expect(sealBytes(plain, row, KEY).equals(sealBytes(plain, row, KEY))).toBe(false);
  });

  it('does not open for another row, another table, or the wrong key, and says only what kind of failure it was', () => {
    const envelope = sealBytes(plain, row, KEY);
    expect(failure(() => openBytes(envelope, { ...row, id: 'row-2' }, ring)).failure).toBe(
      'cannot_open',
    );
    expect(failure(() => openBytes(envelope, { ...row, purpose: 'checkin' }, ring)).failure).toBe(
      'cannot_open',
    );
    const elsewhere = must(ringOf(OTHER.key));
    const unknown = failure(() => openBytes(envelope, row, elsewhere));
    expect(unknown.failure).toBe('unknown_key');
    expect(unknown.message).not.toContain('PLANTED');
  });

  it('binds the row in each layer by itself: the data key opens only for its row, and the payload only for its row', () => {
    const envelope = sealBytes(plain, row, KEY);
    const { fingerprint, wrapped, payload } = binaryParts(envelope);
    const other = { ...row, id: 'row-2' };
    // The wrapping carries the row and the key.
    expect(() => decrypt(KEY.key, wrapped, rowWrapAad(other, fingerprint))).toThrow(CryptoError);
    expect(() => decrypt(KEY.key, wrapped, rowWrapAad(row, OTHER.fingerprint))).toThrow(
      CryptoError,
    );
    // The payload carries it again, so that a data key moved to another row's envelope opens nothing there.
    const dataKey = decrypt(KEY.key, wrapped, rowWrapAad(row, fingerprint));
    expect(decrypt(dataKey, payload, rowPayloadAad(row)).equals(plain)).toBe(true);
    expect(() => decrypt(dataKey, payload, rowPayloadAad(other))).toThrow(CryptoError);
    expect(() => decrypt(dataKey, payload, rowPayloadAad({ ...row, purpose: 'checkin' }))).toThrow(
      CryptoError,
    );
  });

  it('is not the text form, and the text form is not it', () => {
    const text = seal('x', row, KEY);
    expect(failure(() => openBytes(Buffer.from(text), row, ring)).failure).toBe('malformed');
    expect(
      failure(() => open(sealBytes(plain, row, KEY).toString('base64url'), row, ring)).failure,
    ).toBe('malformed');
  });

  it('refuses what has been cut, changed or re-labelled with another key', () => {
    const envelope = sealBytes(plain, row, KEY);
    expect(failure(() => openBytes(envelope.subarray(0, 8), row, ring)).failure).toBe('malformed');
    expect(failure(() => openBytes(Buffer.alloc(0), row, ring)).failure).toBe('malformed');
    const flipped = Buffer.from(envelope);
    flipped[flipped.length - 1] = (flipped[flipped.length - 1] ?? 0) ^ 1;
    expect(failure(() => openBytes(flipped, row, ring)).failure).toBe('cannot_open');
    const relabelled = Buffer.from(envelope);
    Buffer.from(OTHER.fingerprint, 'hex').copy(relabelled, 1);
    const both = must(ringOf(KEY.key, OTHER.key));
    expect(failure(() => openBytes(relabelled, row, both)).failure).toBe('cannot_open');
    expect(fingerprintOfEnvelope(Buffer.from('nonsense'))).toBeUndefined();
  });

  it('moves to another key without touching the payload, and then opens under the new key alone', () => {
    const envelope = sealBytes(plain, row, KEY);
    const moved = rewrapBytes(envelope, row, KEY, OTHER);
    expect(fingerprintOfEnvelope(moved)).toBe(OTHER.fingerprint);
    // The payload, which is the end of the envelope, is byte for byte the same.
    expect(moved.subarray(moved.length - 40).equals(envelope.subarray(envelope.length - 40))).toBe(
      true,
    );
    expect(openBytes(moved, row, must(ringOf(OTHER.key))).equals(plain)).toBe(true);
    expect(failure(() => openBytes(moved, row, ring)).failure).toBe('unknown_key');
    expect(failure(() => rewrapBytes(moved, row, KEY, OTHER)).failure).toBe('unknown_key');
    expect(failure(() => rewrapBytes(envelope, { ...row, id: 'row-2' }, KEY, OTHER)).failure).toBe(
      'cannot_open',
    );
  });

  it('seals nothing, and a lot', () => {
    for (const size of [0, 1, 4096, 1_000_000]) {
      const bytes = randomBytes(size);
      expect(openBytes(sealBytes(bytes, row, KEY), row, ring).equals(bytes)).toBe(true);
    }
  });
});
