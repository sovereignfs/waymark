import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '../..');

/** Every file under a folder, as a path from the repository's root. */
function files(folder: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(path.join(ROOT, folder))) {
    const relative = path.join(folder, name);
    if (statSync(path.join(ROOT, relative)).isDirectory()) out.push(...files(relative));
    else if (/\.(ts|tsx|mjs)$/.test(name)) out.push(relative);
  }
  return out;
}

const source = [...files('src'), ...files('app')].filter((file) => !/\.test\.tsx?$/.test(file));

describe('where the environment is read', () => {
  it('is only in src/config: nothing else touches process.env', () => {
    const offenders = source
      .filter((file) => !file.startsWith(path.join('src', 'config') + path.sep))
      .filter((file) => readFileSync(path.join(ROOT, file), 'utf8').includes('process.env'));
    expect(offenders).toEqual([]);
  });

  it('declares every WAYMARK_ setting the code names in .env.example', () => {
    const declared = new Set(
      [
        ...readFileSync(path.join(ROOT, '.env.example'), 'utf8').matchAll(
          /^#? ?([A-Z][A-Z0-9_]+)=/gm,
        ),
      ].map((match) => match[1]),
    );
    const named = new Set<string>();
    for (const file of source) {
      const text = readFileSync(path.join(ROOT, file), 'utf8');
      for (const match of text.matchAll(/['"`](WAYMARK_[A-Z0-9_]+)['"`]/g)) {
        const name = match[1];
        if (name) named.add(name);
      }
    }
    // A secret may be declared by its `_FILE` form alone, and the plain name is the same setting.
    const isDeclared = (name: string) =>
      declared.has(name) ||
      declared.has(`${name}_FILE`) ||
      declared.has(name.replace(/_FILE$/, ''));
    const missing = [...named].filter((name) => !isDeclared(name));
    expect(missing).toEqual([]);
    // The check is not vacuous: the code does name settings.
    expect(named.size).toBeGreaterThan(5);
  });
});
