import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * **No navigation or data decision is forked by viewport** (DESIGN.md §20.12): the same addresses and the same data at every width, and only what is drawn
 * differs. A width is asked for by `useIsMobile` or `matchMedia`, and only the files below may (each draws something differently and decides nothing else); a new
 * file that asks must be added here, which is where someone looks at whether it is a rendering choice. And none of these may navigate, fetch, read or write the
 * working copy on the strength of it.
 */
const ROOT = path.resolve(__dirname, '..', '..');

/** Files that draw differently by width, and why. */
const RENDERING_ONLY: Record<string, string> = {
  'src/ui/useSidebar.ts': 'whether the sidebar is drawn (a phone has the footer and the drawer)',
  'src/ui/SidebarToggle.tsx':
    'what the header button does to what is drawn: hides the sidebar, or opens the drawer',
  'src/screens/CheckInSurface.tsx':
    'whether the check-in is a sheet or a drawer: the same content, opened and closed the same way by CheckInSheet',
  'src/screens/CheckinsLayout.tsx':
    'whether a selected check-in is beside the list or a page of its own: the address is /c/<id> either way',
  'src/theme/script.ts': 'the colour scheme the device prefers, not a width',
};
/** Files that draw by width and also write, because that is what they are for. None yet. */
const ALSO_WRITES = new Set<string>([]);
/** What a file that draws by width must not also do. */
const NOT_BY_WIDTH =
  /\b(router\.(push|replace)|window\.location\.(assign|replace)|fetch\(|useLocal\()/;

function walk(folder: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(path.join(ROOT, folder))) {
    const relative = path.join(folder, name);
    if (statSync(path.join(ROOT, relative)).isDirectory()) out.push(...walk(relative));
    else if (/\.(ts|tsx)$/.test(name)) out.push(relative);
  }
  return out;
}

describe('a width', () => {
  const files = [...walk('src'), ...walk('app')];
  const asking = files
    .filter((file) => !/\.test\.tsx?$/.test(file))
    .filter((file) =>
      /\b(useIsMobile|matchMedia|innerWidth)\b/.test(readFileSync(path.join(ROOT, file), 'utf8')),
    );

  it('is asked for only by the files that draw differently by it', () => {
    expect(asking.filter((file) => !(file in RENDERING_ONLY))).toEqual([]);
  });

  it('decides nothing in those files but what is drawn: they do not navigate, fetch or touch the working copy by it', () => {
    const offenders = asking
      .filter((file) => file in RENDERING_ONLY && !ALSO_WRITES.has(file))
      .filter((file) => NOT_BY_WIDTH.test(readFileSync(path.join(ROOT, file), 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('is not asked for in a route, a layout or a handler', () => {
    const inApp = asking.filter((file) => file.startsWith('app/'));
    expect(inApp).toEqual([]);
  });
});
