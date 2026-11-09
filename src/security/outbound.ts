import { BlockList, isIP } from 'node:net';
import { lookup as dnsLookup } from 'node:dns';
import http from 'node:http';
import https from 'node:https';

/**
 * **Every request the server makes to anything else goes through `outbound()`** (DESIGN.md §25 Security): place search and reverse lookup (4.2), the
 * tile upstream (4.3), the Swarm import's photos (8.2), push services (12.4), and nothing else (SMTP and core are protocols and clients of their own,
 * but are held to the same list of hosts by configuration). It is the one place that says what an outbound request may be:
 *
 *  - **Only to a host it was given** (`allow`): an exact name, or `*.example.com` for the names under it (never `example.com` itself). Anything else
 *    is refused before a connection is made, and so is a redirect to a host outside the list: a redirect is followed only within it, up to a few hops.
 *  - **Never to a private address**, unless the host is the operator's own and says so (`allowPrivate`: a Nominatim on the same network as the app).
 *    The address is checked **at connection**, in the lookup the connection itself uses, and the connection goes to the address that was checked, so
 *    a name that answers with a public address to a check and a private one to the connection (DNS rebinding) reaches nothing. An address written as
 *    the host is checked as it is.
 *  - **With a timeout** over the whole exchange, and **a size cap** on the answer, which stops reading and refuses when it is passed.
 *  - **http only to the operator's host that says so** (`allowHttp`), https for everything else.
 *
 * A failure is an `OutboundError` with a kind and no address, query or body in its message: a place search is a place name, and **a log holds no
 * search text** (an id and a kind of failure).
 */
export type OutboundKind =
  'host_not_allowed' | 'private_address' | 'redirect_refused' | 'too_large' | 'timeout' | 'failed';

export class OutboundError extends Error {
  override name = 'OutboundError';
  constructor(readonly kind: OutboundKind) {
    super(`an outbound request was refused or failed: ${kind}`);
  }
}

export interface HostRule {
  /** `search.example.com`, or `*.example.com` for any name under it. Lower case. */
  host: string;
  /** The operator's own host may be on a private network. Never set for an allow-list taken from a person or a file. */
  allowPrivate?: boolean;
  /** Plain http, for the operator's own host on a network of its own. Never for a name from a person or a file. */
  allowHttp?: boolean;
}

export interface OutboundOptions {
  allow: readonly HostRule[];
  method?: 'GET' | 'POST' | 'HEAD';
  headers?: Record<string, string>;
  body?: string | Buffer;
  /** The whole exchange, redirects included. Default 10 seconds. */
  timeoutMs?: number;
  /** The most bytes of answer to read. Default 5 MiB. */
  maxBytes?: number;
  /** The most redirects to follow, each to a host in `allow`. Default 3. */
  maxRedirects?: number;
}

export interface OutboundResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_MAX_REDIRECTS = 3;

/** Addresses that are not the public internet's: this host, this network, link-local, shared, documentation, multicast, reserved. */
const PRIVATE = new BlockList();
for (const [net, bits] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const)
  PRIVATE.addSubnet(net, bits, 'ipv4');
for (const [net, bits] of [
  ['::', 128],
  ['::1', 128],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
  ['2001:db8::', 32],
  ['100::', 64],
] as const)
  PRIVATE.addSubnet(net, bits, 'ipv6');

/** Whether an address is one a request must not reach: an IPv4-mapped IPv6 address is judged as the IPv4 address it carries. */
export function isPrivateAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return true; // not an address at all: refuse
  if (PRIVATE.check(address, family === 4 ? 'ipv4' : 'ipv6')) return true;
  // NAT64 (64:ff9b::/96) carries an IPv4 address in its last 32 bits.
  const nat64 = /^64:ff9b::(?:([0-9a-f]{1,4}):([0-9a-f]{1,4})|(\d+\.\d+\.\d+\.\d+))$/i.exec(
    address,
  );
  if (nat64) {
    if (nat64[3]) return isPrivateAddress(nat64[3]);
    const hi = parseInt(nat64[1] ?? '0', 16);
    const lo = parseInt(nat64[2] ?? '0', 16);
    return isPrivateAddress(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }
  return false;
}

/** The rule a host falls under, or undefined: an exact name, or a name under a `*.` rule (and not the bare domain). */
export function ruleFor(host: string, allow: readonly HostRule[]): HostRule | undefined {
  const name = host.toLowerCase().replace(/^\[|\]$/g, '');
  return allow.find((rule) =>
    rule.host.startsWith('*.') ? name.endsWith(rule.host.slice(1)) : name === rule.host,
  );
}

/** A `lookup` for a connection that refuses a private address, unless the host's rule allows it: the address checked is the address connected to. */
function guardedLookup(allowPrivate: boolean): NonNullable<http.RequestOptions['lookup']> {
  return (hostname, options, callback) => {
    dnsLookup(hostname, { ...options, all: true }, (error, addresses) => {
      if (error) return callback(error, '', 0);
      const list = (addresses as { address: string; family: number }[]) ?? [];
      const first = list[0];
      if (!first || (!allowPrivate && list.some((entry) => isPrivateAddress(entry.address)))) {
        return callback(new OutboundError('private_address') as NodeJS.ErrnoException, '', 0);
      }
      if ((options as { all?: boolean }).all) {
        return (callback as unknown as (e: null, a: typeof list) => void)(null, list);
      }
      return callback(null, first.address, first.family);
    });
  };
}

/** One request, not following a redirect. */
function once(
  url: URL,
  rule: HostRule,
  options: OutboundOptions,
  signal: AbortSignal,
  maxBytes: number,
): Promise<OutboundResponse> {
  return new Promise((resolve, reject) => {
    const client = url.protocol === 'https:' ? https : http;
    const host = url.hostname.replace(/^\[|\]$/g, '');
    const literal = isIP(host) !== 0;
    if (literal && !rule.allowPrivate && isPrivateAddress(host)) {
      return reject(new OutboundError('private_address'));
    }
    const request = client.request(
      url,
      {
        method: options.method ?? 'GET',
        headers: options.headers,
        signal,
        // Nothing is kept alive: the next request may be to another host, and a pooled socket was connected under another rule.
        agent: false,
        lookup: guardedLookup(rule.allowPrivate === true),
      },
      (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > maxBytes) {
            request.destroy();
            reject(new OutboundError('too_large'));
            return;
          }
          chunks.push(chunk);
        });
        response.on('end', () =>
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks),
          }),
        );
        response.on('error', () => reject(new OutboundError('failed')));
      },
    );
    request.on('error', (error) => {
      if (error instanceof OutboundError) return reject(error);
      if ((error as { code?: string }).code === 'ERR_INVALID_URL')
        return reject(new OutboundError('failed'));
      const cause = (error as { cause?: unknown }).cause;
      if (cause instanceof OutboundError) return reject(cause);
      return reject(new OutboundError(signal.aborted ? 'timeout' : 'failed'));
    });
    if (options.body !== undefined) request.write(options.body);
    request.end();
  });
}

export async function outbound(
  address: string,
  options: OutboundOptions,
): Promise<OutboundResponse> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let current: URL;
    try {
      current = new URL(address);
    } catch {
      throw new OutboundError('failed');
    }
    // What each request of the exchange carries: the first, as it was given; a redirect is a plain GET, and a redirect to **another host** carries none
    // of the caller's headers (a key given to one host is not sent to another).
    let step: OutboundOptions = options;
    for (let hop = 0; ; hop++) {
      const rule = ruleFor(current.hostname, options.allow);
      if (!rule) throw new OutboundError(hop === 0 ? 'host_not_allowed' : 'redirect_refused');
      if (current.username || current.password) throw new OutboundError('failed');
      if (current.protocol !== 'https:' && !(current.protocol === 'http:' && rule.allowHttp)) {
        throw new OutboundError(hop === 0 ? 'host_not_allowed' : 'redirect_refused');
      }
      const response = await once(current, rule, step, controller.signal, maxBytes);
      const location = response.headers.location;
      if (response.status >= 300 && response.status < 400 && location) {
        if (hop >= maxRedirects) throw new OutboundError('redirect_refused');
        let next: URL;
        try {
          next = new URL(location, current);
        } catch {
          throw new OutboundError('redirect_refused');
        }
        step = {
          ...options,
          method: 'GET',
          body: undefined,
          headers: next.host === current.host ? options.headers : undefined,
        };
        current = next;
        continue;
      }
      return response;
    }
  } catch (error) {
    if (error instanceof OutboundError) throw error;
    throw new OutboundError(controller.signal.aborted ? 'timeout' : 'failed');
  } finally {
    clearTimeout(timer);
  }
}
