export interface Violation {
  file: string;
  line: number;
  message: string;
}

/**
 * Tokens that are never declared in CSS: the app that owns the shell sets them (`AppShell`), and the design system's overlays read them with a
 * fallback so they also work alone. See `docs/design-system.md` in the Sovereign repository.
 */
export const SHELL_TOKENS: ReadonlySet<string> = new Set([
  '--sv-shell-header-height',
  '--sv-shell-footer-height',
  '--sv-shell-sidebar-width',
  '--sv-dialog-inset-top',
  '--sv-dialog-inset-left',
  '--sv-vh',
]);

const TOKEN_DEF_RE = /(--sv-[\w-]+)\s*:/g;
const TOKEN_USE_RE = /var\((--sv-[\w-]+)/g;
const HEX_RE = /#[0-9a-fA-F]{3,8}\b/g;
const RGB_RE = /rgba?\(/g;
const FONT_FAMILY_RE = /(^|[\s;{])font-family\s*:\s*([^;}]+)/g;
const FONT_SHORTHAND_RE = /(^|[\s;{])font\s*:\s*([^;}]+)/g;

/** Strips comments, so a rule written about a declaration is not taken for one. Line breaks stay, so line numbers do. */
const withoutComments = (css: string): string =>
  css.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, ' '));

const lineOf = (text: string, index: number): number => text.slice(0, index).split('\n').length;

/** Every `--sv-*` token that some CSS defines. */
export function definedTokens(definitions: readonly string[]): Set<string> {
  const tokens = new Set<string>(SHELL_TOKENS);
  for (const css of definitions) {
    for (const match of css.matchAll(TOKEN_DEF_RE)) if (match[1]) tokens.add(match[1]);
  }
  return tokens;
}

/**
 * What an app's own CSS may not do (DESIGN.md §15.1): use a `--sv-*` token that is not defined, which resolves to nothing in the browser and
 * stays invisible until someone reads the page pixel by pixel; hard-code a colour that should be a token, so that dark mode and theming break;
 * or name a typeface of its own, when the one place that says which font Sovereign uses is the token.
 */
export function checkCss(file: string, source: string, defined: ReadonlySet<string>): Violation[] {
  const css = withoutComments(source);
  const violations: Violation[] = [];

  for (const match of css.matchAll(TOKEN_USE_RE)) {
    const token = match[1];
    if (token && !defined.has(token)) {
      violations.push({
        file,
        line: lineOf(css, match.index),
        message: `undefined token ${token}`,
      });
    }
  }

  css.split('\n').forEach((line, index) => {
    const hex = line.match(HEX_RE);
    if (hex)
      violations.push({ file, line: index + 1, message: `hardcoded hex literal: ${hex[0]}` });
    if (RGB_RE.test(line)) {
      violations.push({ file, line: index + 1, message: 'hardcoded rgb()/rgba() literal' });
    }
    RGB_RE.lastIndex = 0;
  });

  for (const match of css.matchAll(FONT_FAMILY_RE)) {
    const value = (match[2] ?? '').trim();
    if (value === 'inherit' || /^var\(--sv-font-family(-mono)?\)$/.test(value)) continue;
    violations.push({
      file,
      line: lineOf(css, match.index + (match[1] ?? '').length),
      message: `font-family must be var(--sv-font-family) or inherit, not ${value}`,
    });
  }
  for (const match of css.matchAll(FONT_SHORTHAND_RE)) {
    const value = (match[2] ?? '').trim();
    if (value === 'inherit') continue;
    violations.push({
      file,
      line: lineOf(css, match.index + (match[1] ?? '').length),
      message: `the font shorthand names a family: use font-size, font-weight and var(--sv-font-family), not ${value}`,
    });
  }
  return violations;
}
