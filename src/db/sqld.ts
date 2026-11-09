import type { Client } from '@libsql/client/web';

/**
 * sqld (the libSQL server) connectivity. One sqld serves several logical databases
 * through *namespaces*: `waymark` for the app and `waymark_auth` for better-auth, the
 * analogue of PostgreSQL's two schemas (DESIGN.md §24). A request picks its
 * namespace with the `x-namespace` header; namespaces are created through sqld's
 * separate admin API.
 *
 * The client is `@libsql/client/web`, the HTTP-only build: it has no native addon,
 * so an sqld or PostgreSQL instance never loads one. Only the `file:` form needs
 * the native client (see `client.ts`).
 */

/** An `@libsql/client` for one namespace of the sqld at `url`. */
export async function createSqldClient(url: string, namespace: string): Promise<Client> {
  const { createClient } = await import('@libsql/client/web');
  return createClient({
    url,
    fetch: (input: unknown, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      headers.set('x-namespace', namespace);
      return fetch(input as string, { ...init, headers });
    },
  });
}

/**
 * Create a namespace through the admin API. Idempotent: sqld answers 400 when it
 * already exists, which is what this wants to be true, so that is success.
 */
export async function provisionNamespace(adminUrl: string, namespace: string): Promise<void> {
  const response = await fetch(`${adminUrl}/v1/namespaces/${namespace}/create`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  if (response.ok || response.status === 400) return;
  throw new Error(
    `could not create the sqld namespace "${namespace}": HTTP ${response.status} ${await response.text()}`,
  );
}
