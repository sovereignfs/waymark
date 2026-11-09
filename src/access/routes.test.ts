import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ROUTES, type RouteAccess, type RouteRule } from './routes';

/**
 * Every route says who may use it (DESIGN.md §7): the files under `app/` are held to the table in `routes.ts`, both ways. A new page or endpoint
 * with no entry fails here, as does an entry whose route is gone or that names a method it does not answer, so that "who may call this" is
 * answered before a route is merged and cannot drift afterwards. And a route the table says is for an account must be written the one way that
 * finds the session and checks `Origin` (`accountRoute`, or `requireAccount()` for a page), so a handler cannot be added that forgets to ask.
 */
const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);
const WRITES = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** The HTTP methods a route file exports, in any of the ways Next.js takes them. */
export function exportedMethods(source: string): string[] {
  const found = new Set<string>();
  for (const match of source.matchAll(
    /export\s+(?:async\s+function|const|function)\s+([A-Z]+)\b/g,
  )) {
    const name = match[1];
    if (name && METHODS.has(name)) found.add(name);
  }
  for (const match of source.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const part of (match[1] ?? '').split(',')) {
      const name = part
        .trim()
        .split(/\s+as\s+/)
        .pop()
        ?.trim();
      if (name && METHODS.has(name)) found.add(name);
    }
  }
  return [...found].sort();
}

interface Found {
  route: string;
  kind: 'page' | 'api';
  methods: string[];
  source: string;
}

/** Every page and API route under an `app` directory, as the router spells it, with what a route file answers. */
export function findRoutes(appDir: string): Found[] {
  const out: Found[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      if (entry.name !== 'page.tsx' && entry.name !== 'route.ts') continue;
      // A route group `(name)` and a parallel slot `@name` are not in the address.
      const segments = relative(appDir, dir)
        .split(sep)
        .filter((s) => s !== '' && !/^\(.*\)$/.test(s) && !s.startsWith('@'))
        // An intercepting route, `(.)account`, is the address after its marker.
        .map((s) => s.replace(/^\(\.{1,3}\)/, ''));
      const source = readFileSync(path, 'utf8');
      out.push({
        route: `/${segments.join('/')}`,
        kind: entry.name === 'page.tsx' ? 'page' : 'api',
        methods: entry.name === 'page.tsx' ? [] : exportedMethods(source),
        source,
      });
    }
  };
  walk(appDir);
  return out.sort((a, b) => a.route.localeCompare(b.route));
}

/** Whether a route file exports `method` as `accountRoute(…)`: the one wrapper that finds the session and checks `Origin`. */
export function isWrapped(source: string, method: string): boolean {
  return new RegExp(`export\\s+const\\s+${method}\\s*=\\s*accountRoute\\(`).test(source);
}

/** What is wrong between the files and the table, as sentences. Empty means they agree. */
export function problems(found: Found[], rules: RouteRule[]): string[] {
  const out: string[] = [];
  const byRoute = new Map(rules.map((rule) => [rule.route, rule]));
  for (const file of found) {
    const rule = byRoute.get(file.route);
    if (!rule) {
      out.push(
        `${file.kind === 'page' ? 'page' : 'API route'} ${file.route} has no rule in routes.ts: say who may use it`,
      );
      continue;
    }
    if (file.kind === 'page') {
      if (!rule.page) out.push(`${file.route} is a page and its rule has no \`page\``);
      else if (rule.page.kind === 'account' && !file.source.includes('requireAccount('))
        out.push(`${file.route} is for an account and its page never calls requireAccount()`);
      continue;
    }
    const ruled = Object.keys(rule.methods ?? {}).sort();
    if (JSON.stringify(ruled) !== JSON.stringify(file.methods)) {
      out.push(
        `${file.route} answers ${file.methods.join(', ') || 'nothing'} and its rule says ${ruled.join(', ') || 'nothing'}`,
      );
      continue;
    }
    for (const [method, access] of Object.entries(rule.methods ?? {})) {
      if (access.kind === 'account' && !isWrapped(file.source, method))
        out.push(
          `${method} ${file.route} is for an account and is not exported as accountRoute(…)`,
        );
      if (access.kind === 'public' && WRITES.has(method) && !access.because)
        out.push(
          `${method} ${file.route} is public and changes something: say in \`because\` what stands in for a session`,
        );
    }
  }
  for (const rule of rules)
    if (!found.some((file) => file.route === rule.route))
      out.push(`${rule.route} has a rule and no route`);
  return out;
}

describe('every route says who may use it', () => {
  it('has a rule for each page and API route under app/, and none for one that is gone', () => {
    expect(problems(findRoutes(join(process.cwd(), 'app')), ROUTES)).toEqual([]);
  });

  it('has one rule for each route, and each rule says something', () => {
    expect(new Set(ROUTES.map((rule) => rule.route)).size).toBe(ROUTES.length);
    for (const rule of ROUTES)
      expect(
        rule.page !== undefined || Object.keys(rule.methods ?? {}).length > 0,
        rule.route,
      ).toBe(true);
  });
});

describe('the check can fail', () => {
  const scratch = () => mkdtempSync(join(tmpdir(), 'waymark-routes-'));
  const file = (root: string, path: string, content: string) => {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), content);
  };
  const mine = (access: RouteAccess): RouteRule['methods'] => ({ POST: access });

  it('reports a route with no rule, a rule with no route, and a method that does not match', () => {
    const root = scratch();
    try {
      file(root, 'page.tsx', '');
      file(
        root,
        'api/open/route.ts',
        'export async function GET() {}\nexport async function DELETE() {}',
      );
      file(root, 'api/new/route.ts', 'export async function POST() {}');
      file(root, '(group)/hidden/page.tsx', '');
      const rules: RouteRule[] = [
        { route: '/', page: { kind: 'public' } },
        { route: '/api/open', methods: { GET: { kind: 'public' } } },
        { route: '/gone', page: { kind: 'public' } },
      ];
      expect(problems(findRoutes(root), rules).sort()).toEqual(
        [
          '/api/open answers DELETE, GET and its rule says GET',
          '/gone has a rule and no route',
          'API route /api/new has no rule in routes.ts: say who may use it',
          'page /hidden has no rule in routes.ts: say who may use it',
        ].sort(),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports a handler for an account that does not go through the wrapper, however it is written', () => {
    const root = scratch();
    try {
      const rule = (route: string): RouteRule => ({ route, methods: mine({ kind: 'account' }) });
      file(
        root,
        'api/wrapped/route.ts',
        'export const POST = accountRoute(async () => new Response());',
      );
      file(root, 'api/bare/route.ts', 'export async function POST() { return new Response(); }');
      file(
        root,
        'api/lookalike/route.ts',
        'export const POST = notAccountRoute(async () => new Response());',
      );
      file(
        root,
        'api/aliased/route.ts',
        'const h = accountRoute(async () => new Response());\nexport { h as POST };',
      );
      expect(
        problems(findRoutes(root), [
          rule('/api/wrapped'),
          rule('/api/bare'),
          rule('/api/lookalike'),
          rule('/api/aliased'),
        ]).sort(),
      ).toEqual(
        [
          'POST /api/aliased is for an account and is not exported as accountRoute(…)',
          'POST /api/bare is for an account and is not exported as accountRoute(…)',
          'POST /api/lookalike is for an account and is not exported as accountRoute(…)',
        ].sort(),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports a page for an account that never asks who is there', () => {
    const root = scratch();
    try {
      file(root, 'lists/page.tsx', 'export default function Page() { return null; }');
      file(
        root,
        'mine/page.tsx',
        'export default async function Page() { await requireAccount(); }',
      );
      expect(
        problems(findRoutes(root), [
          { route: '/lists', page: { kind: 'account' } },
          { route: '/mine', page: { kind: 'account' } },
        ]),
      ).toEqual(['/lists is for an account and its page never calls requireAccount()']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports a public route that changes something and does not say what stands in for a session', () => {
    const root = scratch();
    try {
      file(root, 'api/hook/route.ts', 'export async function POST() {}');
      const rule = (access: RouteAccess): RouteRule[] => [
        { route: '/api/hook', methods: mine(access) },
      ];
      expect(problems(findRoutes(root), rule({ kind: 'public' }))).toEqual([
        'POST /api/hook is public and changes something: say in `because` what stands in for a session',
      ]);
      expect(
        problems(findRoutes(root), rule({ kind: 'public', because: 'a signed token' })),
      ).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reads the ways a route file exports its methods', () => {
    expect(exportedMethods('export async function POST() {}')).toEqual(['POST']);
    expect(exportedMethods('const h = () => {};\nexport { h as DELETE, h as PUT };')).toEqual([
      'DELETE',
      'PUT',
    ]);
    expect(
      exportedMethods("export const GET = () => {};\nexport const dynamic = 'force-dynamic';"),
    ).toEqual(['GET']);
    expect(exportedMethods("export const dynamic = 'x';")).toEqual([]);
  });
});
