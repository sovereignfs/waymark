import type { Problem } from '../config';

/**
 * How people sign in (DESIGN.md §19.1), checked once at start-up with the other settings (`src/config/index.ts`), which is why this reads through
 * a function it is given and not the environment. A wrong setting is a problem that stops the server, and no message carries a value.
 *
 *   WAYMARK_AUTH_LOCAL                 1 or true: email and password. Off means off: `/sign-in`, `/sign-up` and `/api/auth` answer 404.
 *   WAYMARK_AUTH_SECRET[_FILE]         32 characters or more, to sign sessions and tokens. Required with local sign-in.
 *   WAYMARK_AUTH_SIGNUP                `closed` (the default with local sign-in): the first account is made and then sign-up is refused, by the
 *                                    server. `open`: anyone who can reach the page. A self-hoster who forgets is not an open registration.
 *                                    With a core as the only way in the default is `open`: the core decides who may sign in.
 *   WAYMARK_AUTH_PASSWORD_MIN_LENGTH   the shortest password, 10 by default.
 *   WAYMARK_URL                        the address people use; required with either way (links, cookies, passkeys and the redirect are made from it).
 *   WAYMARK_CORE_URL, WAYMARK_CORE_CLIENT_ID, WAYMARK_CORE_CLIENT_SECRET[_FILE]
 *                                   Sovereign sign-in, through a core (DESIGN.md §19.1): all three or none. Either way, or both, can be on.
 *
 * With none of the ways on there is no sign-in at all, and the other settings here are not read.
 */
export interface AuthSettings {
  /** The address people use, an origin with no path. */
  readonly url: string;
  readonly secret: string;
  readonly signUp: 'open' | 'closed';
  readonly passwordMinLength: number;
  /** Email and password, passkeys and an authenticator app are on. Off means off: their pages and routes answer 404. */
  readonly local: boolean;
  /** Sign-in through a core, or `undefined` when it is not set up. */
  readonly sovereign: SovereignSettings | undefined;
}

export interface SovereignSettings {
  /** Core's address, its OIDC issuer: no trailing slash. Its discovery document is at `/.well-known/openid-configuration` under it. */
  readonly issuer: string;
  readonly clientId: string;
  readonly clientSecret: string;
}

/** The id Sovereign sign-in is known by: it is in the redirect address registered with core, and it is the `provider_id` of the account it makes. */
export const SOVEREIGN_PROVIDER_ID = 'sovereign';

/**
 * What Waymark asks core for in phase 1. The manifest (`sovereign.manifest.json`) says the same, which a test holds it to. `offline_access` and
 * `directory` join with invitations (10.2, 14.2; DESIGN.md §19.3).
 */
export const SOVEREIGN_SCOPES = ['openid', 'profile', 'email'];

export const MIN_SECRET_LENGTH = 32;
const DEFAULT_PASSWORD_MIN_LENGTH = 10;
const LONGEST_MIN_PASSWORD = 128;

/** The code a refused sign-up carries, in the API's answer. */
export const SIGNUP_CLOSED = 'SIGNUP_CLOSED';

/** Reads a setting by name, as `loadConfig` does: a secret may be a file, and an empty value is no value. */
export type Read = (name: string) => string | undefined;

/**
 * `url` is `WAYMARK_URL` once checked, and absent when it was not given or was wrong (which `loadConfig` has already reported). Returns the
 * settings, or `undefined` when sign-in is off; a wrong setting is pushed to `problems`.
 */
export function resolveAuth(
  read: Read,
  url: string | undefined,
  problems: Problem[],
): AuthSettings | undefined {
  const local = readFlag(read, 'WAYMARK_AUTH_LOCAL', problems);
  const sovereign = resolveSovereign(read, problems);
  if (!local && !sovereign) return undefined;
  const why = local ? 'WAYMARK_AUTH_LOCAL is on' : 'Sovereign sign-in is set';

  if (url === undefined && read('WAYMARK_URL') === undefined) {
    problems.push(
      `${why}, so WAYMARK_URL (the address people use) is required: links, cookies and the sign-in redirect are made from it.`,
    );
  }

  const secret = read('WAYMARK_AUTH_SECRET');
  if (secret === undefined) {
    problems.push(`${why}, so WAYMARK_AUTH_SECRET (or WAYMARK_AUTH_SECRET_FILE) is required.`);
  } else if (secret.length < MIN_SECRET_LENGTH) {
    problems.push(
      `WAYMARK_AUTH_SECRET must be at least ${MIN_SECRET_LENGTH} characters (openssl rand -base64 48 makes one).`,
    );
  }

  // Unset, it is closed, unless a core is the only way in: then the core already decides who may sign in, and closed would admit only the
  // first of its people (contracts/app-manifest.md §4 in sovereignfs/sovereign).
  const rawSignUp =
    (read('WAYMARK_AUTH_SIGNUP') ?? '').toLowerCase() || (local ? 'closed' : 'open');
  if (rawSignUp !== 'open' && rawSignUp !== 'closed') {
    problems.push('WAYMARK_AUTH_SIGNUP is open or closed.');
  }

  const rawLength = read('WAYMARK_AUTH_PASSWORD_MIN_LENGTH');
  let passwordMinLength = DEFAULT_PASSWORD_MIN_LENGTH;
  if (rawLength !== undefined) {
    const parsed = Number(rawLength);
    if (!Number.isInteger(parsed) || parsed < 8 || parsed > LONGEST_MIN_PASSWORD) {
      problems.push(
        `WAYMARK_AUTH_PASSWORD_MIN_LENGTH is a whole number from 8 to ${LONGEST_MIN_PASSWORD}.`,
      );
    } else passwordMinLength = parsed;
  }

  if (url === undefined || secret === undefined) return undefined;
  if (secret.length < MIN_SECRET_LENGTH || (rawSignUp !== 'open' && rawSignUp !== 'closed')) {
    return undefined;
  }
  return { url, secret, signUp: rawSignUp, passwordMinLength, local, sovereign };
}

/**
 * Sovereign sign-in: off when none of the three is given, and a problem (from `loadConfig`'s groups) when only some are, in which case it is
 * left off here and the problem is what stops the server. The secret may be a file.
 */
function resolveSovereign(read: Read, problems: Problem[]): SovereignSettings | undefined {
  const issuer = read('WAYMARK_CORE_URL');
  const clientId = read('WAYMARK_CORE_CLIENT_ID');
  const clientSecret = read('WAYMARK_CORE_CLIENT_SECRET');
  if (issuer === undefined || clientId === undefined || clientSecret === undefined) {
    return undefined;
  }
  let parsed: URL;
  try {
    parsed = new URL(issuer);
  } catch {
    problems.push('WAYMARK_CORE_URL is not an address. Give it as https://sovereign.example.com.');
    return undefined;
  }
  // The client secret goes to this host, and the people who sign in are trusted as it says they are.
  if (
    parsed.protocol !== 'https:' &&
    !(parsed.protocol === 'http:' && isLocalHost(parsed.hostname))
  ) {
    problems.push('WAYMARK_CORE_URL must be https, except on localhost.');
    return undefined;
  }
  if (parsed.search || parsed.hash || parsed.username || parsed.password) {
    problems.push('WAYMARK_CORE_URL has no user, query or fragment.');
    return undefined;
  }
  return {
    issuer: `${parsed.origin}${parsed.pathname}`.replace(/\/+$/, ''),
    clientId,
    clientSecret,
  };
}

function isLocalHost(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '[::1]' ||
    hostname.endsWith('.localhost')
  );
}

/** A switch is 1 or true to be on, 0 or false (or nothing) to be off; anything else is a mistake and is not guessed at. */
function readFlag(read: Read, name: string, problems: Problem[]): boolean {
  const value = read(name)?.toLowerCase();
  if (value === undefined || value === '0' || value === 'false') return false;
  if (value === '1' || value === 'true') return true;
  problems.push(`${name} is 1 or 0.`);
  return false;
}
