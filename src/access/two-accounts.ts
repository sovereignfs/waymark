import { type TestAuth, type TestClient, makeAuth } from '../auth/test-support';
import type { AccessDeps } from './route';

/**
 * Two accounts on one instance, for **every server test that needs to call as the wrong one** (DESIGN.md §7): seed what `ada` owns, then ask
 * for it as `grace`, and assert that the answer is the one for a row that is not there and that nothing changed. It makes a real auth store
 * (on whichever database the leg runs on) and real sessions, so what is tested is the same check a request meets in the server.
 *
 *   const t = await twoAccounts();
 *   const reply = await t.as(t.grace).post('/api/…', body);   // a Reply, as the auth tests read them
 *   const response = await handler(t.request(t.grace, '/api/…', { method: 'POST', body })); // a route handler, called as grace
 */
export interface Person {
  /** The account id: better-auth's user id, which is what a row's `owner_id` holds. */
  id: string;
  email: string;
  client: TestClient;
}

export interface TwoAccounts {
  auth: TestAuth;
  /** What `accountRoute` is given, to wrap a handler under test with this instance's better-auth. */
  deps: AccessDeps;
  ada: Person;
  grace: Person;
  /** A client that is a particular person's browser, to call better-auth's own endpoints. */
  as(person: Person): TestClient;
  /**
   * A request as a person's browser would send it: with their cookies and this instance's `Origin`. `person` null is a visitor with no session.
   * `headers` can change anything, `origin: ''` removing it.
   */
  request(
    person: Person | null,
    path: string,
    init?: { method?: string; body?: unknown; headers?: Record<string, string> },
  ): Request;
  close(): Promise<void>;
}

const PASSWORD = 'a password long enough to be one';

export async function twoAccounts(): Promise<TwoAccounts> {
  const auth = await makeAuth({ signUp: 'open' });
  const person = async (name: string, ip: string): Promise<Person> => {
    const client = auth.client().from(ip);
    const email = `${name.toLowerCase()}@example.com`;
    const reply = await client.post('/api/auth/sign-up/email', { name, email, password: PASSWORD });
    if (reply.status !== 200) throw new Error(`could not seed ${name}: ${reply.status}`);
    return { id: reply.body.user.id as string, email, client };
  };
  const ada = await person('Ada', '198.51.100.1');
  const grace = await person('Grace', '198.51.100.2');

  return {
    auth,
    deps: {
      origin: () => auth.settings.url,
      accountOf: async (headers) => (await auth.auth.api.getSession({ headers }))?.user.id ?? null,
    },
    ada,
    grace,
    as: (who) => who.client,
    request(who, path, init = {}) {
      const { method = 'GET', body, headers = {} } = init;
      const sent = new Headers({
        origin: auth.settings.url,
        ...(who ? { cookie: who.client.cookieHeader() } : {}),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...headers,
      });
      if (sent.get('origin') === '') sent.delete('origin');
      return new Request(new URL(path, auth.settings.url), {
        method,
        headers: sent,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    },
    close: () => auth.close(),
  };
}
