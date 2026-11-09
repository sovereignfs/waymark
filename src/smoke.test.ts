import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { site } from './site';

// A runner that finds no tests passes silently, so there is always one that cannot: the package an instance builds names this app. (Once the manifest
// exists, 1.10, this reads it instead.)
describe('the test runner', () => {
  it('runs, and the package names the app', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      name: string;
    };
    expect(pkg.name).toBe('@sovereignfs/waymark');
    expect(site.name).toBe('Waymark');
  });
});
