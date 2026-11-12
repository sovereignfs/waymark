import type { DatabaseConfig } from '../db/config';

/**
 * **The seed refuses to run against anything but a development database** (task 16.1). It makes accounts with a password written in this repository, so it must never reach a database a real person
 * could be using. There is no way to prove a database is a development one, so the rule is the opposite: it runs only where everything it would touch is plainly on this machine, and says which
 * thing was not.
 *
 *   - `NODE_ENV` is not `production`;
 *   - the database is a file, or a service (sqld, PostgreSQL) on `localhost`, `127.0.0.1`, `[::1]` or a `*.localhost` name, or the host Docker gives a container for the machine;
 *   - the address people use (`WAYMARK_URL`), if there is one, is on this machine too (an instance with a public address has real people);
 *   - the data directory is not `/data`, which is where the image keeps a real instance's.
 *
 * The answer is the list of what is wrong, empty when the seed may run. It names settings and never their values (a database address can hold a password).
 */
export interface SeedTarget {
  readonly nodeEnv: string | undefined;
  readonly url: string | undefined;
  readonly database: DatabaseConfig;
  readonly dataDir: string;
}

const LOCAL = new Set(['localhost', '127.0.0.1', '[::1]', '::1', 'host.docker.internal']);

export function isLocalHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return LOCAL.has(host) || host.endsWith('.localhost');
}

function hostOf(address: string): string | undefined {
  try {
    return new URL(address).hostname;
  } catch {
    return undefined;
  }
}

export function developmentProblems(target: SeedTarget): string[] {
  const problems: string[] = [];
  if (target.nodeEnv === 'production')
    problems.push('NODE_ENV is production. The seed is for a development machine only.');
  const { database } = target;
  if (database.dialect === 'sqlite' && database.form === 'sqld') {
    for (const [setting, address] of [
      ['WAYMARK_SQLD_URL', database.url],
      ['WAYMARK_SQLD_ADMIN_URL', database.adminUrl],
    ] as const) {
      const host = hostOf(address);
      if (host === undefined || !isLocalHost(host))
        problems.push(`${setting} is not on this machine, so it is not a development database.`);
    }
  } else if (database.dialect === 'postgres') {
    const host = hostOf(database.url);
    if (host === undefined || !isLocalHost(host))
      problems.push(
        'WAYMARK_POSTGRES_URL is not on this machine, so it is not a development database.',
      );
  } else if (database.dialect === 'sqlite' && database.form === 'file') {
    if (database.path.startsWith('/data/'))
      problems.push('WAYMARK_SQLITE_URL is under /data, where an instance keeps its own database.');
  }
  if (target.url !== undefined) {
    const host = hostOf(target.url);
    if (host === undefined || !isLocalHost(host))
      problems.push(
        'WAYMARK_URL is not on this machine: an instance people use has real accounts.',
      );
  }
  if (target.dataDir === '/data' || target.dataDir.startsWith('/data/'))
    problems.push(
      'WAYMARK_DATA_DIR is /data, where an instance keeps its own files. Set one for development.',
    );
  return problems;
}
