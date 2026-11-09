import {
  ConfigError,
  defineConfig,
  Secret,
  secret,
  string,
  type Variable,
} from '@sovereignfs/config';

/** The environment as a plain map, so that every rule about it can be tested with one that was made for the test. */
export type Env = Readonly<Record<string, string | undefined>>;

/** Reads a file; a parameter so that a test need not write one. */
export type ReadFile = (path: string) => string;

/**
 * **The only place the process environment is read** (src/config/process-env.test.ts holds it to that). Everything else is given an `Env`, or
 * asks one of the functions below.
 */
export function processEnv(): Env {
  return process.env;
}

/**
 * Which settings are secrets: only these take the `NAME_FILE` form (contracts/env.md §3), are printed as `[redacted]` and are never defaulted.
 * Every other setting is read as text and checked by the code that uses it.
 */
const SECRETS = new Set([
  'AUTH_SECRET',
  'CORE_CLIENT_SECRET',
  'ENCRYPTION_KEY',
  'ENCRYPTION_KEY_PREVIOUS',
  'POSTGRES_URL',
  'SMTP_PASSWORD',
]);

/** Every setting the app reads as text, by its name without the prefix. */
const TEXT = [
  'URL',
  'WORKER',
  'AUTH_LOCAL',
  'AUTH_SIGNUP',
  'AUTH_PASSWORD_MIN_LENGTH',
  'CORE_URL',
  'CORE_CLIENT_ID',
  'DB_DIALECT',
  'DB_CONNECT_TIMEOUT_MS',
  'SQLD_URL',
  'SQLD_ADMIN_URL',
  'SQLITE_URL',
  'POSTGRES_POOL_MAX',
  'MIGRATIONS_DIR',
  'SMTP_HOST',
  'SMTP_PORT',
  'SMTP_FROM',
  'SMTP_USER',
] as const;

const PREFIX = 'WAYMARK_';

/** The declaration of every setting the app reads from the environment, through `@sovereignfs/config` (contracts/env.md). */
const settings = defineConfig({
  prefix: 'WAYMARK',
  variables: Object.fromEntries([
    ...TEXT.map((name) => [name, string({ name })] as const),
    ...[...SECRETS].map((name) => [name, secret({ name })] as const),
  ]) as Record<string, Variable<string | Secret | undefined>>,
});

/** What was read: a setting by its full name (`WAYMARK_URL`), or `undefined` when it is not given. A secret's value is revealed here and only here. */
export type Read = (name: string) => string | undefined;

/** The result of reading the environment: the settings, or what is wrong with how they were given (never a value). */
export type Reading = { ok: true; read: Read } | { ok: false; problems: readonly string[] };

/**
 * Reads every setting once. A secret may be `NAME` or the file `NAME_FILE` names; both together is refused, as `contracts/env.md` §3 says
 * (it was once the file that won), and a `_FILE` for a setting that is not a secret is refused. A blank value is no value. A problem names the variable and never a value or a path.
 */
export function readEnvironment(env: Env, readFile?: ReadFile): Reading {
  // Only a secret takes the file form; a `_FILE` given for any other setting is refused, so that it is not silently ignored.
  const notFiles = TEXT.map((name) => `${PREFIX}${name}_FILE`)
    .filter((name) => (env[name] ?? '').trim() !== '')
    .map((name) => `${name} is not read: only a secret can be given as a file.`);
  if (notFiles.length > 0) return { ok: false, problems: notFiles };
  try {
    const values = settings.load({ ...env }, readFile ? { readFile } : {}) as Record<
      string,
      string | Secret | undefined
    >;
    return {
      ok: true,
      read: (name) => {
        const value = values[name.startsWith(PREFIX) ? name.slice(PREFIX.length) : name];
        return value instanceof Secret ? value.reveal() : value;
      },
    };
  } catch (error) {
    if (error instanceof ConfigError) return { ok: false, problems: describe(error) };
    throw error;
  }
}

function describe(error: ConfigError): string[] {
  return error.problems.map((problem) => `${problem.variable} ${problem.message}.`);
}

/**
 * One secret by its full name, as `NAME` or `NAME_FILE`, for a caller that reads one setting alone. Throws a `ConfigError` for a file that
 * cannot be read or for both forms given.
 */
export function readSecret(env: Env, name: string, readFile?: ReadFile): string | undefined {
  const one = defineConfig({
    prefix: 'WAYMARK',
    variables: { value: secret({ name: name.slice(PREFIX.length) }) },
  });
  return one.load({ ...env }, readFile ? { readFile } : {}).value?.reveal();
}
