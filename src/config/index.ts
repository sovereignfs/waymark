import { resolveAuth, type AuthSettings } from '../auth/config';
import { resolveMail } from '../mail/config';
import { type PlacesSettings, resolvePlaces } from '../places/config';
import type { MailSettings } from '../mail/mailer';
import { type KeyRing, parseKey, ringOf } from '../crypto/keys';
import { DatabaseConfigError, resolveDatabaseSettings, type DatabaseSettings } from '../db/config';
import { readEnvironment, type Env, type ReadFile } from './env';

/** What the app was told, once it has been checked. It grows as the tasks that read a setting are built. */
export interface Config {
  /** The address people use, with no path. Absent when the app is run with no sign-in, which only a development machine does. */
  readonly url: string | undefined;
  /** Whether this process runs the background jobs (DESIGN.md §5): off for all but one process when several share a database. */
  readonly worker: boolean;
  /** How people sign in, or `undefined` when no way is on: there is then no sign-in, and its addresses answer 404 (DESIGN.md §19.1). */
  readonly auth: AuthSettings | undefined;
  /** Which database, and how to wait for it and migrate it (DESIGN.md §24.1). */
  readonly database: DatabaseSettings;
  /** The instance key, and the one it replaces while rows are moved to it. Always present: what Waymark stores is sealed with it (DESIGN.md §18.1). */
  readonly encryption: KeyRing;
  /** Where files are kept and how much one account may keep (DESIGN.md §18.3). */
  readonly media: MediaSettings;
  /** Place search: which provider and where, or `off` (DESIGN.md §7.2). */
  readonly places: PlacesSettings;
  /** Where mail goes, or `undefined`: then an address is not verified, a password is not reset by mail, and no screen or route offers either (DESIGN.md §19.1). */
  readonly mail: MailSettings | undefined;
}

/** The directory everything the app writes beside the database is under (`/data` in the image), and the most one account may keep in files. */
export interface MediaSettings {
  readonly dataDir: string;
  readonly maxAccountBytes: number;
}

export const DEFAULT_DATA_DIR = '/data';
export const DEFAULT_MEDIA_MAX_ACCOUNT_MB = 500;

/** One thing that is wrong, in words that name the setting and never its value. */
export type Problem = string;

export type LoadResult =
  | { readonly ok: true; readonly config: Config }
  | { readonly ok: false; readonly problems: readonly Problem[] };

/**
 * Settings that only make sense together: all of them or none. A partial set stops the server at start-up, because the part that is missing
 * would otherwise be found at the moment a person needs it.
 */
const GROUPS: readonly { readonly what: string; readonly names: readonly string[] }[] = [
  {
    what: 'Sovereign sign-in',
    names: ['WAYMARK_CORE_URL', 'WAYMARK_CORE_CLIENT_ID', 'WAYMARK_CORE_CLIENT_SECRET'],
  },
];

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** localhost, an address on this machine, or a name under `.localhost`: the only places plain http is allowed. */
function isLocalHost(hostname: string): boolean {
  return LOCAL_HOSTS.has(hostname) || hostname.endsWith('.localhost');
}

const KEY_HELP =
  'It is 32 random bytes, in base64, URL-safe base64 or hex (openssl rand -base64 32).';

/** The instance key and the previous one, as a ring, or what is wrong with them. */
function checkKeys(
  current: string | undefined,
  previous: string | undefined,
  problems: Problem[],
): KeyRing | undefined {
  const key = current === undefined ? undefined : parseKey(current);
  const old = previous === undefined ? undefined : parseKey(previous);
  if (current === undefined)
    problems.push(
      `WAYMARK_ENCRYPTION_KEY (or WAYMARK_ENCRYPTION_KEY_FILE) is required: everything Waymark stores about where and what is sealed with it. ${KEY_HELP}`,
    );
  else if (key === undefined) problems.push(`WAYMARK_ENCRYPTION_KEY is not a key. ${KEY_HELP}`);
  if (previous !== undefined && old === undefined)
    problems.push(`WAYMARK_ENCRYPTION_KEY_PREVIOUS is not a key. ${KEY_HELP}`);
  if (previous !== undefined && current === undefined)
    problems.push(
      'WAYMARK_ENCRYPTION_KEY_PREVIOUS is given, and there is no WAYMARK_ENCRYPTION_KEY to move the rows to.',
    );
  if (key && old && key.equals(old))
    problems.push('WAYMARK_ENCRYPTION_KEY_PREVIOUS is the same key as WAYMARK_ENCRYPTION_KEY.');
  return ringOf(key, old);
}

/** Checks `WAYMARK_URL`. Returns the origin to keep, or says what is wrong. */
function checkUrl(value: string): { url: string } | { problem: Problem } {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return {
      problem: 'WAYMARK_URL is not an address. Give it as https://waymark.example.com.',
    };
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return { problem: 'WAYMARK_URL must be an http or https address.' };
  }
  if (parsed.protocol === 'http:' && !isLocalHost(parsed.hostname)) {
    return {
      problem:
        'WAYMARK_URL must be https, except on localhost: passkeys, emailed links and the sign-in redirect are made from it.',
    };
  }
  if (parsed.username || parsed.password) {
    return { problem: 'WAYMARK_URL must not carry a user name or password.' };
  }
  if ((parsed.pathname !== '/' && parsed.pathname !== '') || parsed.search || parsed.hash) {
    return { problem: 'WAYMARK_URL is the address with no path, query or fragment.' };
  }
  return { url: parsed.origin };
}

/**
 * Reads and checks every setting the app has been told. It never throws and never reads the process: the environment and the way to read a
 * file are given, so a test can try every mistake. A message names a setting, and a value appears in none.
 */
export function loadConfig(env: Env, readFile?: ReadFile): LoadResult {
  const problems: Problem[] = [];

  // Every setting is read once, through @sovereignfs/config; a file that cannot be read, or a secret given both ways, is reported alone,
  // since the settings that depend on it would only add problems of their own.
  const reading = readEnvironment(env, readFile);
  if (!reading.ok) return { ok: false, problems: reading.problems };
  const read = reading.read;

  let url: string | undefined;
  const rawUrl = read('WAYMARK_URL');
  if (rawUrl !== undefined) {
    const checked = checkUrl(rawUrl);
    if ('problem' in checked) problems.push(checked.problem);
    else url = checked.url;
  }

  // Signing in: checked with the address, since links, cookies and passkeys are made from it.
  const auth = resolveAuth(read, url, problems);

  const rawWorker = read('WAYMARK_WORKER');
  if (rawWorker !== undefined && rawWorker !== 'on' && rawWorker !== 'off') {
    problems.push('WAYMARK_WORKER is on or off.');
  }

  for (const group of GROUPS) {
    const given = group.names.filter((name) => read(name) !== undefined);
    if (given.length > 0 && given.length < group.names.length) {
      const missing = group.names.filter((name) => !given.includes(name));
      problems.push(
        `${group.what} needs all of its settings or none, and ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} missing.`,
      );
    }
  }

  // The instance key (DESIGN.md §18.1): required, since nothing that says where or what is stored without it. A key that is given must be a
  // key, and a message names the setting and never what was given.
  const encryption = checkKeys(
    read('WAYMARK_ENCRYPTION_KEY'),
    read('WAYMARK_ENCRYPTION_KEY_PREVIOUS'),
    problems,
  );

  // Files (DESIGN.md §18.3): the data directory is `/data`, which the image makes and the manifest declares, unless the operator says another; a limit for each account.
  const rawDataDir = read('WAYMARK_DATA_DIR');
  const dataDir = (rawDataDir ?? DEFAULT_DATA_DIR).replace(/\/+$/, '') || '/';
  if (!dataDir.startsWith('/')) problems.push('WAYMARK_DATA_DIR is an absolute path.');
  const rawLimit = read('WAYMARK_MEDIA_MAX_ACCOUNT_MB');
  let limitMb = DEFAULT_MEDIA_MAX_ACCOUNT_MB;
  if (rawLimit !== undefined) {
    const parsed = Number(rawLimit);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 1_000_000)
      problems.push('WAYMARK_MEDIA_MAX_ACCOUNT_MB is a whole number of megabytes, 1 or more.');
    else limitMb = parsed;
  }

  // Mail is optional, but a host with no sender would send nothing anyone could answer, so it stops here rather than at the first message.
  const mail = resolveMail(read, problems);

  // Place search: the provider and where it is, with the public instance's usage policy unless the operator names their own.
  const places = resolvePlaces(read, problems);

  // The database: which of the three forms, and the address it needs. A secret address may arrive as a file.
  let database: DatabaseSettings | undefined;
  try {
    database = resolveDatabaseSettings({
      ...env,
      WAYMARK_POSTGRES_URL: read('WAYMARK_POSTGRES_URL'),
      WAYMARK_POSTGRES_URL_FILE: undefined,
    });
  } catch (error) {
    if (error instanceof DatabaseConfigError) problems.push(error.message);
    else throw error;
  }

  if (problems.length > 0 || database === undefined || encryption === undefined) {
    return { ok: false, problems };
  }
  return {
    ok: true,
    config: {
      url,
      auth,
      worker: rawWorker !== 'off',
      database,
      encryption,
      media: { dataDir, maxAccountBytes: limitMb * 1024 * 1024 },
      mail,
      places,
    },
  };
}
