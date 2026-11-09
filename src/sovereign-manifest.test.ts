import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { secretsOf, validate } from '@sovereignfs/manifest';
import { describe, expect, it } from 'vitest';
import { SOVEREIGN_PROVIDER_ID, SOVEREIGN_SCOPES } from './auth/config';

/**
 * The manifest a Sovereign instance reads to host Waymark (`sovereign.manifest.json`, DESIGN.md §19.3; the contract is `contracts/app-manifest.md` in
 * `sovereignfs/sovereign`). It is held to the manifest's own schema, by `@sovereignfs/manifest` (which `pnpm manifest:check` runs too), and to the code and
 * files it makes promises about, so that a change to a route, a scope, an icon or a port that the manifest has not followed fails here and not on an operator's
 * server.
 */
const root = join(import.meta.dirname, '..');
const read = (path: string) => readFileSync(join(root, path), 'utf8');
const manifest = JSON.parse(read('sovereign.manifest.json')) as {
  prefix: string;
  name: string;
  description: string;
  port: number;
  health: string;
  launch: string;
  icon: string;
  signIn: { redirect: string[]; scopes: string[]; backChannel: string; accountDeleted: string };
  database: unknown;
  data: string[];
  generate: (string | { name: string; bytes?: number })[];
};

/** The path of a route file in the app router for an address. */
const routeFile = (address: string) =>
  join(root, 'app', ...address.split('/').filter(Boolean), 'route.ts');

describe('sovereign.manifest.json', () => {
  it('meets the manifest’s schema, and the schema refuses what is wrong, so that the check is a check', () => {
    expect(validate(manifest)).toMatchObject({ ok: true });
    expect(validate({ ...manifest, prefix: 'Waymark' }).ok).toBe(false);
    expect(validate({ ...manifest, port: 0 }).ok).toBe(false);
    expect(validate({ ...manifest, extra: true }).ok).toBe(false);
  });

  it('names the app Waymark, with a description that says what it is, and its variables WAYMARK_', () => {
    expect(manifest.prefix).toBe('waymark');
    expect(manifest.name).toBe('Waymark');
    expect(manifest.description.length).toBeGreaterThan(40);
    for (const entry of manifest.generate) {
      const name = typeof entry === 'string' ? entry : entry.name;
      expect(name.startsWith('WAYMARK_'), name).toBe(true);
    }
  });

  it('asks the instance to make the secrets the app needs, at the sizes it reads', () => {
    const made = secretsOf(manifest);
    // The session secret is 32 characters or more (a name alone is 48 bytes); the instance key is exactly 32 bytes.
    expect(made).toContainEqual({ name: 'WAYMARK_AUTH_SECRET', bytes: 48 });
    expect(made).toContainEqual({ name: 'WAYMARK_ENCRYPTION_KEY', bytes: 32 });
    const config = read('src/auth/config.ts') + read('src/config/index.ts');
    expect(config).toContain('WAYMARK_AUTH_SECRET');
    expect(config).toContain('WAYMARK_ENCRYPTION_KEY');
  });

  it('asks core for what the sign-in asks for, and is sent back where the sign-in is sent', () => {
    expect(manifest.signIn.scopes).toEqual(SOVEREIGN_SCOPES);
    expect(manifest.signIn.redirect).toEqual([`/api/auth/callback/${SOVEREIGN_PROVIDER_ID}`]);
  });

  it('names a health route and a launch address that exist', () => {
    expect(existsSync(routeFile(manifest.health))).toBe(true);
    expect(manifest.launch).toBe('/');
    expect(existsSync(join(root, 'app', '(app)', 'page.tsx'))).toBe(true);
  });

  it('names an icon the app serves to a launcher with no session, which the proxy leaves alone', () => {
    expect(manifest.icon).toBe('/icons/icon.svg');
    expect(existsSync(join(root, 'public', manifest.icon))).toBe(true);
    expect(read('proxy.ts')).toMatch(/matcher:[\s\S]*?\|icons\//);
  });

  it('needs a database, and does not say it works through a pooler, since it holds a lock for its migrations', () => {
    expect(manifest.database).toBe(true);
  });

  it('names the addresses Sovereign sends its notices to; the routes that answer them, and the access list that lets Sovereign in, arrive with 2.4', () => {
    expect(manifest.signIn.backChannel).toBe('/api/sovereign/backchannel-logout');
    expect(manifest.signIn.accountDeleted).toBe('/api/sovereign/account-deleted');
  });

  it('declares /data, which the image makes and its user may write, and the settings it asks core to make are the ones the code requires', () => {
    expect(manifest.data).toEqual(['/data']);
    expect(read('Dockerfile')).toMatch(/RUN mkdir \/data && chown node:node \/data/);
  });
});

describe('the port', () => {
  it('is the one the image is built with, from the manifest and nowhere else', () => {
    const dockerfile = read('Dockerfile');
    expect(dockerfile).toContain('ARG PORT');
    expect(dockerfile).toContain('PORT=${PORT}');
    expect(dockerfile).toContain('EXPOSE ${PORT}');
  });
});

describe('the label', () => {
  const run = (...args: string[]) =>
    execFileSync('pnpm', ['exec', 'sovereign-manifest', ...args], {
      cwd: root,
      encoding: 'utf8',
      stdio: 'pipe',
    });

  it('is made from the file, equal to it, with the port as a build argument', () => {
    const args = run('docker-args', '--format', 'github').trimEnd().split('\n');
    expect(args[1]).toBe(`build-args=PORT=${manifest.port}`);
    // The build action reads `labels` as CSV, in which a field that opens with a quote ends at its closing one, so the label is one such field.
    const field = (args[0] ?? '').slice('labels='.length);
    expect(field.startsWith('"') && field.endsWith('"')).toBe(true);
    expect(
      JSON.parse(field.slice(1, -1).replace(/""/g, '"').split('app-manifest=')[1] ?? ''),
    ).toEqual(manifest);
  });
});
