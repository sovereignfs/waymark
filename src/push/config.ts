import { createECDH, hkdfSync } from 'node:crypto';
import type { Problem } from '../config';

/**
 * **Web Push's key** (DESIGN.md §17.3, §27): `WAYMARK_VAPID_PRIVATE_KEY` is a random secret, which the instance's manifest `generate` makes once (random bytes, as for any secret), and **the EC key push services want is derived from it**, the same
 * every start: a P-256 private scalar from HKDF-SHA-256 over the secret (retried with a counter in the vanishing case that it is not a valid scalar), and the public key from that. So `generate` needs no kind of key it does not have, and the
 * secret is the only thing kept. No value is ever in a message.
 *
 * Optional: with no secret push is off (Settings says so). It also needs `WAYMARK_URL`, which is the VAPID subject (the push service may write to it if the app misbehaves).
 */
export interface PushSettings {
  /** The derived private key, 32 bytes, base64url: what the library signs with. */
  readonly privateKey: string;
  /** The derived public key, an uncompressed P-256 point, base64url: what a browser subscribes with. */
  readonly publicKey: string;
  /** `https://…`: where the push service can reach the operator. */
  readonly subject: string;
}

const b64url = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url');

/** The key pair for a secret: deterministic, and valid. */
export function deriveVapid(secret: string): { privateKey: string; publicKey: string } {
  for (let counter = 0; counter < 16; counter += 1) {
    const raw = hkdfSync(
      'sha256',
      Buffer.from(secret, 'utf8'),
      Buffer.from('waymark:vapid:v1'),
      Buffer.from(`key:${counter}`),
      32,
    );
    const ecdh = createECDH('prime256v1');
    try {
      ecdh.setPrivateKey(Buffer.from(raw));
      return { privateKey: b64url(Buffer.from(raw)), publicKey: b64url(ecdh.getPublicKey()) };
    } catch {
      // Not a valid scalar (zero, or at least the group order): the next counter gives another.
    }
  }
  throw new Error('no valid key could be derived');
}

export function resolvePush(
  read: (name: string) => string | undefined,
  url: string | undefined,
  problems: Problem[],
): PushSettings | undefined {
  const secret = read('WAYMARK_VAPID_PRIVATE_KEY');
  if (secret === undefined) return undefined;
  if (secret.length < 32 || /\s/.test(secret)) {
    problems.push(
      'WAYMARK_VAPID_PRIVATE_KEY is a random secret of at least 32 characters with no spaces: `openssl rand -base64 48`.',
    );
    return undefined;
  }
  // Without an address for the app there is nothing for a push service to be told, and Web Push stays off.
  if (!url) return undefined;
  const { privateKey, publicKey } = deriveVapid(secret);
  return { privateKey, publicKey, subject: url };
}
