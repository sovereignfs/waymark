import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkCss, definedTokens } from './design-tokens';

const ROOT = path.resolve(__dirname, '../..');

/** Every file under a folder whose name ends in one of `extensions`, as a path from the repository's root. */
function files(folder: string, extensions: readonly string[]): string[] {
  const out: string[] = [];
  for (const name of readdirSync(path.join(ROOT, folder))) {
    const relative = path.join(folder, name);
    if (statSync(path.join(ROOT, relative)).isDirectory()) out.push(...files(relative, extensions));
    else if (extensions.some((extension) => name.endsWith(extension))) out.push(relative);
  }
  return out;
}

const UI = path.join(ROOT, 'node_modules/@sovereignfs/ui/dist');
const tokenFiles = ['tokens/primitives.css', 'tokens/semantic.css', 'tokens/theme-presets.css'];
const defined = definedTokens(tokenFiles.map((file) => readFileSync(path.join(UI, file), 'utf8')));

describe('the app’s own CSS', () => {
  const sources = [...files('app', ['.css']), ...files('src', ['.css'])];

  it('is checked: there is some to check', () => {
    expect(sources.length).toBeGreaterThan(1);
    expect(defined.size).toBeGreaterThan(100);
  });

  it('uses only tokens that exist, no literal colour, and no typeface of its own', () => {
    const violations = sources.flatMap((file) =>
      checkCss(file, readFileSync(path.join(ROOT, file), 'utf8'), defined),
    );
    expect(violations).toEqual([]);
  });
});

describe('checkCss', () => {
  const check = (css: string) => checkCss('x.css', css, defined);

  it('accepts tokens, inherit and the token font', () => {
    expect(
      check('a { color: var(--sv-color-text-primary); font-family: var(--sv-font-family); }'),
    ).toEqual([]);
    expect(check('a { font-family: inherit; font: inherit; }')).toEqual([]);
  });

  it('refuses a literal colour', () => {
    expect(check('a { color: #fff; }')).toEqual([
      { file: 'x.css', line: 1, message: 'hardcoded hex literal: #fff' },
    ]);
    expect(check('a {\n  background: rgba(0, 0, 0, 0.5);\n}')[0]).toMatchObject({ line: 2 });
  });

  it('refuses a token that is not defined, with its line', () => {
    expect(check('a {\n  color: var(--sv-color-no-such-thing);\n}')).toEqual([
      { file: 'x.css', line: 2, message: 'undefined token --sv-color-no-such-thing' },
    ]);
  });

  it('accepts the shell tokens, which the app that owns the shell sets', () => {
    expect(check('a { height: var(--sv-shell-header-height); }')).toEqual([]);
  });

  it('refuses a typeface of its own, in either form', () => {
    expect(check("a { font-family: 'Inter', sans-serif; }")[0]?.message).toMatch(/font-family/);
    expect(check('a { font: 12px Inter; }')[0]?.message).toMatch(/shorthand/);
  });

  it('does not take a comment for a declaration', () => {
    expect(
      check('/* a literal #fff is not allowed, nor font-family: Inter */\na { color: red; }'),
    ).toEqual([]);
  });
});
