import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * **What the device's store imports is all the browser gets** (DESIGN.md §15.1): this follows every import that is not only a type, from the store's React provider, and fails for one that reaches the
 * server's code (a database, the keys, `node:` anything) or a package the browser is not meant to carry. A value imported from a server module, even a constant, takes that module and everything it
 * imports into the page: it once took the whole applier in, and a script the page's policy refuses with it.
 */
const root = path.join(process.cwd(), 'src');
const PACKAGES = new Set(['react', 'idb']);

/** The value imports of a file: `import x from`, `import { a, type B } from` (when something is not a type), `export … from`, and side-effect imports; not `import type`. */
export function valueImports(source: string): string[] {
  const out: string[] = [];
  const pattern =
    /^\s*(import|export)\s+(type\s+)?([^'"]*?)\s*from\s*['"]([^'"]+)['"]|^\s*import\s*['"]([^'"]+)['"]/gm;
  for (const match of source.matchAll(pattern)) {
    if (match[5]) {
      out.push(match[5]);
      continue;
    }
    if (match[2]) continue; // import type / export type
    const clause = match[3] ?? '';
    const named = /\{([^}]*)\}/.exec(clause);
    const hasValue =
      !named ||
      clause.replace(/\{[^}]*\}/, '').replace(/[,\s*]|as\s+\w+/g, '') !== '' ||
      (named[1] ?? '')
        .split(',')
        .some((part) => part.trim() !== '' && !part.trim().startsWith('type '));
    if (hasValue) out.push(match[4] as string);
  }
  return out;
}

function closure(entry: string): { files: Set<string>; packages: Set<string> } {
  const files = new Set<string>();
  const packages = new Set<string>();
  const visit = (file: string) => {
    if (files.has(file)) return;
    files.add(file);
    for (const spec of valueImports(readFileSync(file, 'utf8'))) {
      if (spec.startsWith('.')) {
        const base = path.resolve(path.dirname(file), spec);
        const found = ['.ts', '.tsx', '/index.ts', '/index.tsx']
          .map((ext) => base + ext)
          .find(existsSync);
        if (!found)
          throw new Error(`${path.relative(root, file)} imports ${spec}, which is not there`);
        visit(found);
      } else packages.add(spec);
    }
  };
  visit(entry);
  return { files, packages };
}

describe('what the device’s store brings into the browser', () => {
  it('imports no server code and no package the browser is not meant to carry', () => {
    const { files, packages } = closure(path.join(root, 'local', 'LocalProvider.tsx'));
    const names = [...files].map((f) => path.relative(root, f)).sort();
    expect(
      names.filter((n) =>
        /^(db|crypto|auth|media|security|jobs|config|mail|profile|places\/(places|naming|finder|http|server)|sync\/(apply|endpoint|pull|server)|checkins\/photos)/.test(
          n,
        ),
      ),
    ).toEqual([]);
    expect([...packages].filter((p) => !PACKAGES.has(p))).toEqual([]);
    // It is a handful of files, which is the point.
    expect(names).toEqual(
      expect.arrayContaining([
        'local/LocalProvider.tsx',
        'local/store.ts',
        'local/sync.ts',
        'local/loop.ts',
        'local/db.ts',
        'sync/format.ts',
      ]),
    );
    expect(names.length).toBeLessThan(12);
  });

  it('sees a value import of a server module, and not a type import of one', () => {
    expect(valueImports("import { MAX } from '../sync/endpoint';")).toEqual(['../sync/endpoint']);
    expect(valueImports("import { type A, B } from './x';")).toEqual(['./x']);
    expect(
      valueImports(
        "import { type A } from './x';\nimport type { C } from './y';\nexport type { D } from './z';",
      ),
    ).toEqual([]);
    expect(
      valueImports(
        "import './side-effect';\nexport { e } from './e';\nimport def, { f } from './d';",
      ),
    ).toEqual(['./side-effect', './e', './d']);
  });
});
