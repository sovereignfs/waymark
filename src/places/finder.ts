import { claimJob } from '../jobs/claim';
import type { Database } from '../db/client';
import { type OutboundOptions, type OutboundResponse, outbound } from '../security/outbound';
import type { PlacesSettings } from './config';
import {
  type Candidate,
  isAnswer,
  readReverse,
  readSearch,
  reverseUrl,
  searchUrl,
} from './providers';

/**
 * Finding a place through the operator's provider (DESIGN.md §7.2), **from the server only**: the browser never reaches a third party. Everything that leaves goes through the one
 * outbound helper, to the host the settings name and no other.
 *
 * **The public instance's usage policy is kept** (`settings.public`): at most one request a second from the whole server, however many processes share the database (a lease taken in the
 * database for a second, `claimJob`, so one process at a time may send, and the others wait their turn or say it is busy), a User-Agent naming Waymark and the instance's address (never a
 * person's), and results kept for a day, so asking again for the same thing sends nothing. An address of the operator's own lifts all of that. A search of fewer than three characters is
 * not sent (the screen waits for a pause before it asks at all, 7.2).
 *
 * **No search text, name or point is in a log or an error** from here: a failure is a kind, and nothing else is kept. The cache holds results in memory under a key that is a hash of what was
 * asked, and is gone with the process.
 */
export type SearchResult =
  { status: 'ok'; candidates: Candidate[] } | { status: 'off' | 'unavailable' | 'too_short' };
export type ReverseResult =
  { status: 'ok'; candidate: Candidate | undefined } | { status: 'off' | 'unavailable' };

export interface FinderDeps {
  readonly settings: PlacesSettings;
  /** Where the lease that spaces the requests to the public instance is taken. */
  readonly database: Database;
  /** Names the software and the instance's address: `Waymark (https://waymark.example.com)`. */
  readonly userAgent: string;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  /** The outbound helper; a test gives its own to count what leaves. */
  readonly send?: (address: string, options: OutboundOptions) => Promise<OutboundResponse>;
  /** The least time between two requests to the public instance. Default one second, which is its policy. */
  readonly intervalMs?: number;
  /** The longest a request waits for its turn before it says the search is busy. Default eight seconds. */
  readonly waitMs?: number;
  /** How long a result is kept. Default a day. */
  readonly cacheMs?: number;
}

export const MIN_QUERY_LENGTH = 3;
export const MAX_QUERY_LENGTH = 200;
export const PUBLIC_INTERVAL_MS = 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const CACHE_MAX = 500;
const POLL_MS = 100;
const LEASE_JOB = 'places:upstream';

/** What a person typed, as it is searched for: trimmed, one line of single spaces, and no longer than a name is. */
export function cleanQuery(query: string): string {
  return query.replace(/\s+/g, ' ').trim().slice(0, MAX_QUERY_LENGTH);
}

const sleepFor = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class PlaceFinder {
  private readonly cache = new Map<string, { at: number; value: unknown }>();
  private readonly inFlight = new Map<string, Promise<unknown>>();

  constructor(private readonly deps: FinderDeps) {}

  private now() {
    return (this.deps.now ?? Date.now)();
  }

  /** Whether there is a provider at all. */
  get on(): boolean {
    return this.deps.settings.provider !== 'off' && this.deps.settings.url !== undefined;
  }

  async search(query: string): Promise<SearchResult> {
    const { settings } = this.deps;
    if (!this.on || settings.provider === 'off' || settings.url === undefined)
      return { status: 'off' };
    const q = cleanQuery(query);
    if ([...q].length < MIN_QUERY_LENGTH) return { status: 'too_short' };
    const provider = settings.provider;
    const base = settings.url;
    const found = await this.ask(`s:${q.toLowerCase()}`, searchUrl(provider, base, q), (body) =>
      isAnswer(provider, body) ? readSearch(provider, body) : undefined,
    );
    return found === undefined ? { status: 'unavailable' } : { status: 'ok', candidates: found };
  }

  async reverse(lat: number, lng: number): Promise<ReverseResult> {
    const { settings } = this.deps;
    if (!this.on || settings.provider === 'off' || settings.url === undefined)
      return { status: 'off' };
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180)
      return { status: 'unavailable' };
    const provider = settings.provider;
    const base = settings.url;
    // About a metre: the same spot asked for twice is one request to the public instance.
    const at = `${lat.toFixed(5)},${lng.toFixed(5)}`;
    const found = await this.ask(`r:${at}`, reverseUrl(provider, base, lat, lng), (body) =>
      isAnswer(provider, body) ? { candidate: readReverse(provider, body) } : undefined,
    );
    return found === undefined
      ? { status: 'unavailable' }
      : { status: 'ok', candidate: found.candidate };
  }

  /**
   * Asks the provider for `address`, or answers from what it said before. `read` turns the body into the value, or undefined for one that is not an answer. Undefined is returned for
   * anything that went wrong, whatever it was: the person is told the search is not reachable, and nothing says why.
   */
  private async ask<T>(
    key: string,
    address: string,
    read: (body: string) => T | undefined,
  ): Promise<T | undefined> {
    const { settings } = this.deps;
    if (settings.public) {
      const hit = this.cache.get(key);
      if (hit && this.now() - hit.at < (this.deps.cacheMs ?? DAY_MS)) return hit.value as T;
      // The same thing asked for at once is one request.
      const running = this.inFlight.get(key);
      if (running) return (await running) as T | undefined;
    }
    const work = this.fetchOnce(address, read).then((value) => {
      if (settings.public && value !== undefined) this.remember(key, value);
      return value;
    });
    if (settings.public) {
      this.inFlight.set(key, work);
      work.then(
        () => this.inFlight.delete(key),
        () => this.inFlight.delete(key),
      );
    }
    return work;
  }

  private remember(key: string, value: unknown): void {
    this.cache.delete(key);
    this.cache.set(key, { at: this.now(), value });
    while (this.cache.size > CACHE_MAX) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
  }

  private async fetchOnce<T>(
    address: string,
    read: (body: string) => T | undefined,
  ): Promise<T | undefined> {
    const { settings } = this.deps;
    try {
      if (settings.public && !(await this.takeTurn())) return undefined;
      const response = await (this.deps.send ?? outbound)(address, {
        allow: settings.allow,
        headers: { 'user-agent': this.deps.userAgent, accept: 'application/json' },
        timeoutMs: 8_000,
        maxBytes: 512 * 1024,
        maxRedirects: 1,
      });
      if (response.status !== 200) return undefined;
      return read(response.body.toString('utf8'));
    } catch {
      // An outbound refusal or failure, a database that could not be asked: all the same to the person, and none says what was asked.
      return undefined;
    }
  }

  /** Waits for this server's turn to send to the public instance, taken in the database so that every process shares one clock. False when the wait ran out. */
  private async takeTurn(): Promise<boolean> {
    const interval = this.deps.intervalMs ?? PUBLIC_INTERVAL_MS;
    const sleep = this.deps.sleep ?? sleepFor;
    // The lease is of real time, the one clock every process shares: `now` (which a test sets) is only for how long a result is kept.
    const give = Date.now() + (this.deps.waitMs ?? 8_000);
    for (;;) {
      if (await claimJob(this.deps.database, LEASE_JOB, interval, Date.now())) return true;
      if (Date.now() >= give) return false;
      await sleep(POLL_MS + Math.floor(Math.random() * 30));
    }
  }
}
