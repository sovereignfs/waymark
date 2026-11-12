import { describe, expect, it } from 'vitest';
import { loadConfig, type LoadResult } from './index';
import { ConfigError } from '@sovereignfs/config';
import { readEnvironment, readSecret } from './env';

/** The one setting that every start needs: the key that what is stored is sealed with. */
const KEY = 'a'.repeat(64);
const BASE = { WAYMARK_ENCRYPTION_KEY: KEY };

/** The problems of a bad environment, which every test below wants to read and none expects to be empty. */
function problems(result: LoadResult): readonly string[] {
  if (result.ok) throw new Error('the settings were accepted');
  return result.problems;
}

/** The settings of a start, with the key that every start needs; a test names only what it is about. */
const load = (env: Record<string, string | undefined>, readFile?: (path: string) => string) =>
  loadConfig({ ...BASE, ...env }, readFile);

describe('loadConfig', () => {
  it('accepts only the key, and the database is then an sqld service at its default address', () => {
    const result = load(BASE);
    expect(result).toMatchObject({
      ok: true,
      config: {
        url: undefined,
        worker: true,
        auth: undefined,
        mail: undefined,
        database: { database: { form: 'sqld' } },
      },
    });
  });

  it('stops with no key, naming the setting', () => {
    const [problem] = problems(loadConfig({}));
    expect(problem).toContain('WAYMARK_ENCRYPTION_KEY');
  });

  it('reports a wrong database setting with the others, naming it', () => {
    const [problem] = problems(load({ ...BASE, WAYMARK_DB_DIALECT: 'mysql' }));
    expect(problem).toContain('WAYMARK_DB_DIALECT');
  });

  it('reads the PostgreSQL address from a file, and keeps it out of what it reports', () => {
    const result = load(
      { WAYMARK_DB_DIALECT: 'postgres', WAYMARK_POSTGRES_URL_FILE: '/run/db' },
      () => 'postgres://u:hunter2@db:5432/waymark\n',
    );
    expect(result).toMatchObject({ ok: true });
    const bad = problems(
      load(
        { WAYMARK_DB_DIALECT: 'postgres', WAYMARK_POSTGRES_URL_FILE: '/run/db' },
        () => 'hunter2 is not a url',
      ),
    );
    expect(bad.join(' ')).not.toContain('hunter2');
  });

  describe('WAYMARK_URL', () => {
    it('keeps the origin of an https address', () => {
      expect(load({ WAYMARK_URL: 'https://waymark.example.com/' })).toMatchObject({
        ok: true,
        config: { url: 'https://waymark.example.com' },
      });
    });

    it.each([
      'http://localhost:3000',
      'http://127.0.0.1:3000',
      'http://[::1]:3000',
      'http://x.localhost',
    ])('allows plain http on this machine: %s', (url) => {
      expect(load({ WAYMARK_URL: url }).ok).toBe(true);
    });

    it('refuses plain http anywhere else, naming the setting and not the value', () => {
      const [problem] = problems(load({ WAYMARK_URL: 'http://waymark.example.com' }));
      expect(problem).toContain('WAYMARK_URL');
      expect(problem).not.toContain('waymark.example.com');
    });

    it.each([
      ['not an address', 'not-an-address-value'],
      ['another scheme', 'ftp://waymark.example.com'],
      ['a path', 'https://waymark.example.com/app'],
      ['a query', 'https://waymark.example.com/?a=1'],
      ['a user name', 'https://me:secret@waymark.example.com'],
    ])('refuses %s, and never prints it', (_what, url) => {
      const result = problems(load({ WAYMARK_URL: url }));
      expect(result.join(' ')).toContain('WAYMARK_URL');
      expect(result.join(' ')).not.toContain('secret');
      expect(result.join(' ')).not.toContain(url);
    });
  });

  describe('WAYMARK_WORKER', () => {
    it('is on unless it says off', () => {
      expect(load({ WAYMARK_WORKER: 'off' })).toMatchObject({ config: { worker: false } });
      expect(load({ WAYMARK_WORKER: 'on' })).toMatchObject({ config: { worker: true } });
    });

    it('refuses anything else', () => {
      expect(problems(load({ WAYMARK_WORKER: 'yes' }))[0]).toContain('WAYMARK_WORKER');
    });
  });

  /** Sovereign sign-in is a way in, so it needs what any way in needs: the address people use, and a secret to sign sessions with. */
  const SIGNED_IN = {
    WAYMARK_URL: 'https://waymark.example.com',
    WAYMARK_AUTH_SECRET: 'a-secret-that-is-at-least-thirty-two-characters-long',
  };

  describe('settings that go together', () => {
    it.each([
      ['WAYMARK_CORE_URL', 'Sovereign sign-in'],
      ['WAYMARK_CORE_CLIENT_ID', 'Sovereign sign-in'],
    ])('stops on %s given alone', (name, what) => {
      const [problem] = problems(load({ [name]: 'value-that-must-not-appear' }));
      expect(problem).toContain(what);
      expect(problem).not.toContain('value-that-must-not-appear');
    });

    it('names what is missing', () => {
      const [problem] = problems(
        load({ WAYMARK_CORE_URL: 'https://core.example.com', WAYMARK_CORE_CLIENT_ID: 'a' }),
      );
      expect(problem).toContain('WAYMARK_CORE_CLIENT_SECRET is missing');
    });

    it('accepts all of a group', () => {
      expect(
        load({
          ...SIGNED_IN,
          WAYMARK_CORE_URL: 'https://core.example.com',
          WAYMARK_CORE_CLIENT_ID: 'a',
          WAYMARK_CORE_CLIENT_SECRET: 'b',
        }).ok,
      ).toBe(true);
    });

    it('counts a secret given as a file as given', () => {
      const files: Record<string, string> = { '/run/secret': 's3cret\n' };
      const result = load(
        {
          ...SIGNED_IN,
          WAYMARK_CORE_URL: 'https://core.example.com',
          WAYMARK_CORE_CLIENT_ID: 'a',
          WAYMARK_CORE_CLIENT_SECRET_FILE: '/run/secret',
        },
        (path) => files[path] ?? '',
      );
      expect(result.ok).toBe(true);
    });

    it('stops on an SMTP host with no sender', () => {
      expect(problems(load({ WAYMARK_SMTP_HOST: 'smtp.example.com' }))[0]).toContain(
        'WAYMARK_SMTP_FROM',
      );
      expect(
        load({ WAYMARK_SMTP_HOST: 'smtp.example.com', WAYMARK_SMTP_FROM: 'Waymark <a@b.c>' }).ok,
      ).toBe(true);
    });
  });

  describe('the instance key', () => {
    const key = Buffer.alloc(32, 7);
    const other = Buffer.alloc(32, 9);
    const ringOf = (result: LoadResult) => (result.ok ? result.config.encryption : undefined);

    it('is required, and the message says what it is for and never a value', () => {
      const [problem] = problems(loadConfig({}));
      expect(problem).toContain('is required');
    });

    it('is read in base64, URL-safe base64 and hex, from the setting or its file, and known by a fingerprint', () => {
      for (const text of [key.toString('base64'), key.toString('base64url'), key.toString('hex')]) {
        const ring = ringOf(loadConfig({ WAYMARK_ENCRYPTION_KEY: text }));
        expect(ring?.current.key.equals(key), text).toBe(true);
        expect(ring?.current.fingerprint).toMatch(/^[0-9a-f]{16}$/);
        expect(ring?.previous).toBeUndefined();
      }
      const fromFile = ringOf(
        loadConfig(
          { WAYMARK_ENCRYPTION_KEY_FILE: '/run/key' },
          () => `${key.toString('base64')}\n`,
        ),
      );
      expect(fromFile?.current.key.equals(key)).toBe(true);
    });

    it('may have the key it replaces beside it, for the restart that moves the credentials', () => {
      const ring = ringOf(
        loadConfig({
          WAYMARK_ENCRYPTION_KEY: key.toString('hex'),
          WAYMARK_ENCRYPTION_KEY_PREVIOUS: other.toString('hex'),
        }),
      );
      expect(ring?.current.key.equals(key)).toBe(true);
      expect(ring?.previous?.key.equals(other)).toBe(true);
      expect(ring?.previous?.fingerprint).not.toBe(ring?.current.fingerprint);
    });

    it('stops the server for a key that is not one, a previous key with no current one, and the same key twice, naming the setting and never its value', () => {
      const secret = 'hunter2-NOT-A-KEY';
      const wrong = problems(loadConfig({ WAYMARK_ENCRYPTION_KEY: secret }));
      expect(wrong.join(' ')).toContain('WAYMARK_ENCRYPTION_KEY is not a key');
      expect(
        problems(loadConfig({ WAYMARK_ENCRYPTION_KEY: Buffer.alloc(16).toString('hex') })).join(
          ' ',
        ),
      ).toContain('not a key');
      expect(
        problems(
          loadConfig({
            WAYMARK_ENCRYPTION_KEY: key.toString('hex'),
            WAYMARK_ENCRYPTION_KEY_PREVIOUS: secret,
          }),
        ).join(' '),
      ).toContain('WAYMARK_ENCRYPTION_KEY_PREVIOUS is not a key');
      expect(
        problems(loadConfig({ WAYMARK_ENCRYPTION_KEY_PREVIOUS: key.toString('hex') })).join(' '),
      ).toContain('no WAYMARK_ENCRYPTION_KEY to move');
      expect(
        problems(
          loadConfig({
            WAYMARK_ENCRYPTION_KEY: key.toString('hex'),
            WAYMARK_ENCRYPTION_KEY_PREVIOUS: key.toString('base64'),
          }),
        ).join(' '),
      ).toContain('the same key');
      for (const message of [
        ...wrong,
        ...problems(
          loadConfig({
            WAYMARK_ENCRYPTION_KEY: key.toString('hex'),
            WAYMARK_ENCRYPTION_KEY_PREVIOUS: secret,
          }),
        ),
      ])
        expect(message).not.toContain(secret);
    });
  });

  it('reports every problem at once, so that one run fixes them all', () => {
    const result = problems(
      load({
        WAYMARK_URL: 'waymark',
        WAYMARK_WORKER: 'x',
        WAYMARK_CORE_URL: 'https://core.example.com',
      }),
    );
    expect(result).toHaveLength(3); // the address, the worker, and a core with only one of its three settings
  });

  it('turns an unreadable secret file into a problem that names the variable and not the path', () => {
    const result = problems(
      load({ WAYMARK_AUTH_SECRET_FILE: '/run/secrets/nowhere' }, () => {
        throw new Error('ENOENT /run/secrets/nowhere');
      }),
    );
    expect(result.join(' ')).toContain('WAYMARK_AUTH_SECRET_FILE');
    expect(result.join(' ')).not.toContain('/run/secrets/nowhere');
  });
});

describe('files', () => {
  it('are under /data with 500 MB for each account, unless told otherwise', () => {
    expect(load({})).toMatchObject({
      ok: true,
      config: { media: { dataDir: '/data', maxAccountBytes: 500 * 1024 * 1024 } },
    });
    expect(
      load({ WAYMARK_DATA_DIR: '/srv/waymark/', WAYMARK_MEDIA_MAX_ACCOUNT_MB: '20' }),
    ).toMatchObject({
      config: { media: { dataDir: '/srv/waymark', maxAccountBytes: 20 * 1024 * 1024 } },
    });
  });

  it('stop the server for a relative directory and a limit that is not a number of megabytes, naming the setting', () => {
    expect(problems(load({ WAYMARK_DATA_DIR: 'data/here' }))[0]).toContain('WAYMARK_DATA_DIR');
    for (const value of ['0', '-5', 'lots', '1.5'])
      expect(problems(load({ WAYMARK_MEDIA_MAX_ACCOUNT_MB: value }))[0], value).toContain(
        'WAYMARK_MEDIA_MAX_ACCOUNT_MB',
      );
  });
});

describe('the limits of trips (DESIGN.md §10.8)', () => {
  it('are 30 members, 50 stops, 200 items a day, 100 attachments and 300 trips an account, unless told otherwise', () => {
    expect(load({})).toMatchObject({
      ok: true,
      config: {
        limits: {
          tripMembers: 30,
          tripStops: 50,
          dayItems: 200,
          tripAttachments: 100,
          accountTrips: 300,
        },
      },
    });
    expect(
      load({ WAYMARK_LIMIT_TRIP_MEMBERS: '5', WAYMARK_LIMIT_ACCOUNT_TRIPS: '1000000' }),
    ).toMatchObject({
      config: {
        limits: {
          tripMembers: 5,
          tripStops: 50,
          dayItems: 200,
          tripAttachments: 100,
          accountTrips: 1_000_000,
        },
      },
    });
  });

  it('stop the server for a value that is not a whole number of 1 to 1,000,000, naming the setting and not the value', () => {
    for (const name of [
      'WAYMARK_LIMIT_TRIP_MEMBERS',
      'WAYMARK_LIMIT_TRIP_STOPS',
      'WAYMARK_LIMIT_DAY_ITEMS',
      'WAYMARK_LIMIT_TRIP_ATTACHMENTS',
      'WAYMARK_LIMIT_ACCOUNT_TRIPS',
    ])
      for (const value of ['0', '-5', 'lots', '1.5', '1e3', '1000001', '5 6']) {
        const found = problems(load({ [name]: value })).join(' ');
        expect(found, `${name}=${value}`).toContain(name);
        expect(found).not.toContain(value === '5 6' ? '5 6' : `=${value}`);
      }
  });
});

describe('reading the environment', () => {
  const read = (env: Record<string, string | undefined>, name: string, readFile?: () => string) => {
    const reading = readEnvironment(env, readFile);
    if (!reading.ok) throw new Error(reading.problems.join(' '));
    return reading.read(name);
  };

  it('reads the plain name', () => {
    expect(read({ WAYMARK_URL: 'a' }, 'WAYMARK_URL')).toBe('a');
  });

  it('treats an empty value as no value', () => {
    expect(read({ WAYMARK_URL: '' }, 'WAYMARK_URL')).toBeUndefined();
    expect(read({}, 'WAYMARK_URL')).toBeUndefined();
  });

  it('reads a secret from its file, and drops one trailing line break and no more', () => {
    expect(
      read({ WAYMARK_AUTH_SECRET_FILE: '/f' }, 'WAYMARK_AUTH_SECRET', () => ' spaced \n\n'),
    ).toBe(' spaced \n');
  });

  it('refuses a secret given both ways (contracts/env.md §3: the file no longer wins)', () => {
    const reading = readEnvironment(
      { WAYMARK_AUTH_SECRET: 'plain', WAYMARK_AUTH_SECRET_FILE: '/f' },
      () => 'x',
    );
    expect(reading).toEqual({
      ok: false,
      problems: [
        'WAYMARK_AUTH_SECRET is set together with WAYMARK_AUTH_SECRET_FILE; set only one.',
      ],
    });
    expect(
      problems(load({ WAYMARK_AUTH_SECRET: 'plain', WAYMARK_AUTH_SECRET_FILE: '/f' })),
    ).toHaveLength(1);
  });

  it('refuses a file for a setting that is not a secret, rather than ignoring it', () => {
    expect(
      readEnvironment({ WAYMARK_CORE_URL_FILE: '/run/core' }, () => 'https://core.test'),
    ).toEqual({
      ok: false,
      problems: ['WAYMARK_CORE_URL_FILE is not read: only a secret can be given as a file.'],
    });
  });

  it('names the variable, never the path or the cause, of a file that cannot be read', () => {
    const reading = readEnvironment({ WAYMARK_AUTH_SECRET_FILE: '/secret/path' }, () => {
      throw new Error('boom /secret/path');
    });
    expect(reading).toEqual({
      ok: false,
      problems: ['WAYMARK_AUTH_SECRET_FILE names a file that cannot be read.'],
    });
  });

  it('reads one secret alone, and throws a ConfigError for a file it cannot read', () => {
    expect(readSecret({ WAYMARK_POSTGRES_URL: 'p' }, 'WAYMARK_POSTGRES_URL')).toBe('p');
    expect(() =>
      readSecret({ WAYMARK_POSTGRES_URL_FILE: '/x' }, 'WAYMARK_POSTGRES_URL', () => {
        throw new Error('no');
      }),
    ).toThrow(ConfigError);
  });
});
