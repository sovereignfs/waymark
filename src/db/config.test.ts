import { describe, expect, it } from 'vitest';
import {
  DatabaseConfigError,
  describeConfig,
  resolveDatabaseConfig,
  resolveDatabaseSettings,
} from './config';

const noFile = (): string => {
  throw new Error('no file');
};

describe('resolveDatabaseConfig', () => {
  it('defaults to SQLite through an sqld service', () => {
    expect(resolveDatabaseConfig({})).toEqual({
      dialect: 'sqlite',
      form: 'sqld',
      url: 'http://sqld:8080',
      adminUrl: 'http://sqld:8081',
    });
  });

  it('treats an empty WAYMARK_DB_DIALECT as unset, and ignores case and spaces', () => {
    expect(resolveDatabaseConfig({ WAYMARK_DB_DIALECT: '' })).toMatchObject({
      dialect: 'sqlite',
      form: 'sqld',
    });
    expect(resolveDatabaseConfig({ WAYMARK_DB_DIALECT: ' SQLD ' })).toMatchObject({
      dialect: 'sqlite',
      form: 'sqld',
    });
  });

  it('reads an sqld URL and its admin URL, without a trailing slash', () => {
    expect(
      resolveDatabaseConfig({
        WAYMARK_DB_DIALECT: 'sqld',
        WAYMARK_SQLD_URL: 'http://localhost:28080/',
        WAYMARK_SQLD_ADMIN_URL: 'http://localhost:28081/',
      }),
    ).toEqual({
      dialect: 'sqlite',
      form: 'sqld',
      url: 'http://localhost:28080',
      adminUrl: 'http://localhost:28081',
    });
  });

  it.each([
    ['file:/data/waymark.db', '/data/waymark.db', '/data/waymark_auth.db'],
    ['file:///data/waymark.db', '/data/waymark.db', '/data/waymark_auth.db'],
    ['file:./data/waymark.db', './data/waymark.db', './data/waymark_auth.db'],
    ['file:waymark.db', 'waymark.db', 'waymark_auth.db'],
  ])(
    'reads the file %s with WAYMARK_DB_DIALECT=sqlite, and puts the auth database beside it',
    (url, path, authPath) => {
      expect(
        resolveDatabaseConfig({ WAYMARK_DB_DIALECT: 'sqlite', WAYMARK_SQLITE_URL: url }),
      ).toEqual({
        dialect: 'sqlite',
        form: 'file',
        path,
        authPath,
      });
    },
  );

  it.each(['file:', 'file:///', 'file::memory:', 'file:/data/'])(
    'refuses the file URL %s',
    (url) => {
      expect(() =>
        resolveDatabaseConfig({ WAYMARK_DB_DIALECT: 'sqlite', WAYMARK_SQLITE_URL: url }),
      ).toThrow(DatabaseConfigError);
    },
  );

  it('requires a file for sqlite, and refuses an address there', () => {
    expect(() => resolveDatabaseConfig({ WAYMARK_DB_DIALECT: 'sqlite' })).toThrow(
      /requires WAYMARK_SQLITE_URL/,
    );
    expect(() =>
      resolveDatabaseConfig({
        WAYMARK_DB_DIALECT: 'sqlite',
        WAYMARK_SQLITE_URL: 'http://sqld:8080',
      }),
    ).toThrow(/WAYMARK_DB_DIALECT=sqld/);
  });

  it('refuses an sqld URL that is not http(s), and says where a file goes', () => {
    expect(() => resolveDatabaseConfig({ WAYMARK_SQLD_URL: 'libsql://example.turso.io' })).toThrow(
      /WAYMARK_SQLD_URL/,
    );
    expect(() => resolveDatabaseConfig({ WAYMARK_SQLD_URL: 'file:/data/waymark.db' })).toThrow(
      /WAYMARK_SQLITE_URL/,
    );
    expect(() => resolveDatabaseConfig({ WAYMARK_SQLD_URL: 'not a url' })).toThrow(
      /WAYMARK_SQLD_URL is not a valid URL/,
    );
  });

  it('refuses an admin URL that is not http(s)', () => {
    expect(() => resolveDatabaseConfig({ WAYMARK_SQLD_ADMIN_URL: 'ftp://sqld:8081' })).toThrow(
      /WAYMARK_SQLD_ADMIN_URL/,
    );
  });

  it('reads PostgreSQL, with a default pool size', () => {
    expect(
      resolveDatabaseConfig({
        WAYMARK_DB_DIALECT: 'postgres',
        WAYMARK_POSTGRES_URL: 'postgres://u:p@db:5432/waymark',
      }),
    ).toEqual({
      dialect: 'postgres',
      url: 'postgres://u:p@db:5432/waymark',
      poolMax: 10,
    });
  });

  it('reads the PostgreSQL address from a file, as an instance gives a secret', () => {
    const config = resolveDatabaseConfig(
      { WAYMARK_DB_DIALECT: 'postgres', WAYMARK_POSTGRES_URL_FILE: '/run/secrets/db' },
      (path) => (path === '/run/secrets/db' ? 'postgres://u:p@db:5432/waymark\n' : noFile()),
    );
    expect(config).toMatchObject({ dialect: 'postgres', url: 'postgres://u:p@db:5432/waymark' });
  });

  it('refuses the PostgreSQL address given both ways, as for every secret', () => {
    expect(() =>
      resolveDatabaseConfig(
        {
          WAYMARK_DB_DIALECT: 'postgres',
          WAYMARK_POSTGRES_URL: 'postgres://plain/tasks',
          WAYMARK_POSTGRES_URL_FILE: '/x',
        },
        () => 'postgres://from-file/tasks',
      ),
    ).toThrow(/WAYMARK_POSTGRES_URL is set together with WAYMARK_POSTGRES_URL_FILE/);
  });

  it('requires WAYMARK_POSTGRES_URL for PostgreSQL, and it must be a postgres URL, without repeating it', () => {
    expect(() => resolveDatabaseConfig({ WAYMARK_DB_DIALECT: 'postgres' })).toThrow(
      /WAYMARK_POSTGRES_URL/,
    );
    expect(() =>
      resolveDatabaseConfig({ WAYMARK_DB_DIALECT: 'postgres', WAYMARK_POSTGRES_URL: 'http://db' }),
    ).toThrow(/postgres:\/\//);
    const bad = () =>
      resolveDatabaseConfig({
        WAYMARK_DB_DIALECT: 'postgres',
        WAYMARK_POSTGRES_URL: 'hunter2 is not a url',
      });
    expect(bad).toThrow(/WAYMARK_POSTGRES_URL is not a valid URL/);
    expect(bad).not.toThrow(/hunter2/);
  });

  it('does not infer the dialect from a URL', () => {
    // A PostgreSQL URL with the default dialect is a mistake to report, not a hint.
    const config = resolveDatabaseConfig({ WAYMARK_POSTGRES_URL: 'postgres://u:p@db/tasks' });
    expect(config).toMatchObject({ dialect: 'sqlite', form: 'sqld' });
  });

  it('refuses an unknown dialect', () => {
    expect(() => resolveDatabaseConfig({ WAYMARK_DB_DIALECT: 'mysql' })).toThrow(
      /WAYMARK_DB_DIALECT must be "sqld", "sqlite" or "postgres"/,
    );
  });

  it('takes the pool size and CA file for PostgreSQL, and ignores a bad pool size', () => {
    const base = {
      WAYMARK_DB_DIALECT: 'postgres',
      WAYMARK_POSTGRES_URL: 'postgres://u:p@db/tasks',
    };
    expect(
      resolveDatabaseConfig({ ...base, WAYMARK_POSTGRES_POOL_MAX: '12', PGSSLROOTCERT: '/ca.pem' }),
    ).toMatchObject({
      poolMax: 12,
      sslRootCertPath: '/ca.pem',
    });
    for (const bad of ['0', '-3', 'many', '2.5', '']) {
      expect(resolveDatabaseConfig({ ...base, WAYMARK_POSTGRES_POOL_MAX: bad })).toMatchObject({
        poolMax: 10,
      });
    }
  });
});

describe('resolveDatabaseSettings', () => {
  it('waits 30 seconds for a database that is starting, and has no migrations folder of its own, unless told', () => {
    expect(resolveDatabaseSettings({})).toMatchObject({
      connectTimeoutMs: 30_000,
      migrationsDir: undefined,
    });
    expect(
      resolveDatabaseSettings({
        WAYMARK_DB_CONNECT_TIMEOUT_MS: '5000',
        WAYMARK_MIGRATIONS_DIR: ' /app/migrations ',
      }),
    ).toMatchObject({ connectTimeoutMs: 5000, migrationsDir: '/app/migrations' });
  });

  it('ignores a bad timeout rather than trusting it', () => {
    for (const bad of ['0', '-1', 'soon', '']) {
      expect(resolveDatabaseSettings({ WAYMARK_DB_CONNECT_TIMEOUT_MS: bad })).toMatchObject({
        connectTimeoutMs: 30_000,
      });
    }
  });
});

describe('describeConfig', () => {
  it('never prints a password', () => {
    const text = describeConfig(
      resolveDatabaseConfig({
        WAYMARK_DB_DIALECT: 'postgres',
        WAYMARK_POSTGRES_URL: 'postgres://waymark:hunter2@db:5432/app',
      }),
    );
    expect(text).toBe('postgres db:5432/app');
    expect(text).not.toContain('hunter2');
  });

  it('describes the SQLite forms', () => {
    expect(describeConfig(resolveDatabaseConfig({}))).toBe('sqlite via sqld at http://sqld:8080');
    expect(
      describeConfig(
        resolveDatabaseConfig({ WAYMARK_DB_DIALECT: 'sqlite', WAYMARK_SQLITE_URL: 'file:/d/f.db' }),
      ),
    ).toBe('sqlite file /d/f.db');
  });
});
