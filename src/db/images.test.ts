import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The database images the dev script starts are the ones CI tests against. They are
 * written in two places (a workflow cannot import a script), so this keeps them equal:
 * a developer should not be testing on a different sqld than the one CI runs.
 */
const read = (path: string) => readFileSync(join(__dirname, '../..', path), 'utf8');

describe('database images', () => {
  it.each([
    ['SQLD_IMAGE', /const SQLD_IMAGE = ['"]([^'"]+)['"]/],
    ['POSTGRES_IMAGE', /const POSTGRES_IMAGE = ['"]([^'"]+)['"]/],
  ])('%s is the same in the dev script and in CI', (name, devPattern) => {
    const dev = devPattern.exec(read('scripts/dev-db.mjs'))?.[1];
    const ci = new RegExp(`^\\s*${name}: (\\S+)`, 'm').exec(read('.github/workflows/ci.yml'))?.[1];
    expect(dev).toBeTruthy();
    expect(ci).toBeTruthy();
    expect(dev).toBe(ci);
  });
});
