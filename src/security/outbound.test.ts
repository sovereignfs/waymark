import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OutboundError, isPrivateAddress, outbound, ruleFor } from './outbound';

/** A fake host on this machine, so that no test reaches the internet; it counts what reached it. */
interface Fake {
  server: http.Server;
  port: number;
  hits: { url: string; headers: http.IncomingHttpHeaders }[];
}

let handler: (request: http.IncomingMessage, response: http.ServerResponse) => void = () => {};
const fakes: Fake[] = [];

async function fake(): Promise<Fake> {
  const hits: Fake['hits'] = [];
  const server = http.createServer((request, response) => {
    hits.push({ url: request.url ?? '', headers: request.headers });
    handler(request, response);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const entry = { server, port: (server.address() as AddressInfo).port, hits };
  fakes.push(entry);
  return entry;
}

let a: Fake;
let b: Fake;
beforeAll(async () => {
  a = await fake();
  b = await fake();
});
afterAll(async () => {
  await Promise.all(fakes.map((f) => new Promise((resolve) => f.server.close(resolve))));
});

const ok = (body = 'ok') => {
  handler = (_request, response) => response.end(body);
};
const kindOf = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof OutboundError) return error.kind;
    throw error;
  }
  return 'resolved';
};

/** The operator's own host, on this machine: plain http and a private address are what the rule allows. */
const own = { host: 'localhost', allowPrivate: true, allowHttp: true };

describe('which host a rule covers', () => {
  it('matches an exact name, and a name under a `*.` rule but never the bare domain', () => {
    const allow = [{ host: 'search.example.com' }, { host: '*.4sqi.net' }];
    expect(ruleFor('search.example.com', allow)).toBeDefined();
    expect(ruleFor('SEARCH.example.com', allow)).toBeDefined();
    expect(ruleFor('a.b.4sqi.net', allow)).toBeDefined();
    expect(ruleFor('4sqi.net', allow)).toBeUndefined();
    expect(ruleFor('evil4sqi.net', allow)).toBeUndefined();
    expect(ruleFor('4sqi.net.evil.com', allow)).toBeUndefined();
    expect(ruleFor('example.com', allow)).toBeUndefined();
  });
});

describe('which address is private', () => {
  it.each([
    '127.0.0.1',
    '10.1.2.3',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '224.0.0.1',
    '255.255.255.255',
    '::1',
    '::',
    'fd12:3456::1',
    'fe80::1',
    '::ffff:127.0.0.1',
    '::ffff:10.0.0.1',
    '64:ff9b::7f00:1',
    'not-an-address',
  ])('refuses %s', (address) => expect(isPrivateAddress(address)).toBe(true));

  it.each([
    '8.8.8.8',
    '1.1.1.1',
    '100.63.255.255',
    '172.32.0.1',
    '2606:4700:4700::1111',
    '::ffff:8.8.8.8',
  ])('lets %s through', (address) => expect(isPrivateAddress(address)).toBe(false));
});

describe('an outbound request', () => {
  it('reaches the operator’s own host, and says what the answer was', async () => {
    ok('hello');
    const response = await outbound(`http://localhost:${a.port}/path?q=1`, { allow: [own] });
    expect(response.status).toBe(200);
    expect(response.body.toString()).toBe('hello');
  });

  it('refuses a host that is not in the list before it connects', async () => {
    ok();
    const before = a.hits.length;
    expect(await kindOf(outbound(`http://127.0.0.1:${a.port}/`, { allow: [own] }))).toBe(
      'host_not_allowed',
    );
    expect(a.hits.length).toBe(before);
  });

  it('refuses plain http unless the host’s rule allows it', async () => {
    ok();
    const before = a.hits.length;
    expect(
      await kindOf(
        outbound(`http://localhost:${a.port}/`, {
          allow: [{ host: 'localhost', allowPrivate: true }],
        }),
      ),
    ).toBe('host_not_allowed');
    expect(a.hits.length).toBe(before);
  });

  it('refuses a private address written as the host, and a name that resolves to one, unless the rule allows it', async () => {
    ok();
    const before = a.hits.length;
    expect(
      await kindOf(
        outbound(`http://127.0.0.1:${a.port}/`, {
          allow: [{ host: '127.0.0.1', allowHttp: true }],
        }),
      ),
    ).toBe('private_address');
    expect(
      await kindOf(
        outbound(`http://localhost:${a.port}/`, {
          allow: [{ host: 'localhost', allowHttp: true }],
        }),
      ),
    ).toBe('private_address');
    expect(
      await kindOf(
        outbound(`http://[::1]:${a.port}/`, { allow: [{ host: '::1', allowHttp: true }] }),
      ),
    ).toBe('private_address');
    // Nothing reached the host: the address is judged before the connection is made.
    expect(a.hits.length).toBe(before);
  });

  it('follows a redirect inside the list, and not to a host outside it', async () => {
    handler = (request, response) => {
      if (request.url === '/inside') {
        response.writeHead(302, { location: `http://localhost:${b.port}/target` }).end();
      } else if (request.url === '/outside') {
        response.writeHead(302, { location: `http://127.0.0.1:${b.port}/target` }).end();
      } else response.end('target');
    };
    const allow = [own];
    expect((await outbound(`http://localhost:${a.port}/inside`, { allow })).body.toString()).toBe(
      'target',
    );
    const before = b.hits.length;
    expect(await kindOf(outbound(`http://localhost:${a.port}/outside`, { allow }))).toBe(
      'redirect_refused',
    );
    expect(b.hits.length).toBe(before);
  });

  it('refuses a redirect to a private address that the first host’s rule would have allowed', async () => {
    handler = (_request, response) => {
      response.writeHead(302, { location: `http://127.0.0.1:${b.port}/` }).end();
    };
    const before = b.hits.length;
    expect(
      await kindOf(
        outbound(`http://localhost:${a.port}/`, {
          // 127.0.0.1 is listed (so the redirect is "inside the list"), but its rule does not allow a private address.
          allow: [own, { host: '127.0.0.1', allowHttp: true }],
        }),
      ),
    ).toBe('private_address');
    expect(b.hits.length).toBe(before);
  });

  it('stops after the redirects it allows', async () => {
    handler = (_request, response) => {
      response.writeHead(302, { location: `http://localhost:${a.port}/again` }).end();
    };
    expect(
      await kindOf(outbound(`http://localhost:${a.port}/`, { allow: [own], maxRedirects: 2 })),
    ).toBe('redirect_refused');
  });

  it('sends the caller’s headers to the host it was given, and not to another host after a redirect', async () => {
    handler = (request, response) => {
      if (request.url === '/go')
        response.writeHead(302, { location: `http://127.0.0.1:${b.port}/` }).end();
      else response.end('landed');
    };
    const allow = [own, { host: '127.0.0.1', allowPrivate: true, allowHttp: true }];
    const response = await outbound(`http://localhost:${a.port}/go`, {
      allow,
      headers: { authorization: 'Bearer secret-key', 'x-test': 'yes' },
    });
    expect(response.body.toString()).toBe('landed');
    expect(a.hits.at(-1)?.headers.authorization).toBe('Bearer secret-key');
    expect(b.hits.at(-1)?.headers.authorization).toBeUndefined();
    expect(b.hits.at(-1)?.headers['x-test']).toBeUndefined();
  });

  it('keeps to a size, and says so, without keeping what it had read', async () => {
    handler = (_request, response) => response.end('x'.repeat(10_000));
    expect(
      await kindOf(outbound(`http://localhost:${a.port}/`, { allow: [own], maxBytes: 1000 })),
    ).toBe('too_large');
    const within = await outbound(`http://localhost:${a.port}/`, {
      allow: [own],
      maxBytes: 10_000,
    });
    expect(within.body.length).toBe(10_000);
  });

  it('gives up after its time, whether the host never answers or answers slowly', async () => {
    handler = () => {
      // Never answers.
    };
    expect(
      await kindOf(outbound(`http://localhost:${a.port}/`, { allow: [own], timeoutMs: 150 })),
    ).toBe('timeout');
    handler = (_request, response) => {
      response.write('a');
      setTimeout(() => response.end('b'), 2000).unref();
    };
    expect(
      await kindOf(outbound(`http://localhost:${a.port}/`, { allow: [own], timeoutMs: 150 })),
    ).toBe('timeout');
  });

  it('says what failed and never where it was going or what was asked', async () => {
    const secret = 'my-secret-search-text';
    try {
      await outbound(`http://localhost:${a.port}/search?q=${secret}`, {
        allow: [{ host: 'elsewhere.test' }],
      });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(OutboundError);
      expect((error as Error).message).not.toContain(secret);
      expect((error as Error).message).not.toContain('localhost');
    }
    expect(await kindOf(outbound('not a url', { allow: [own] }))).toBe('failed');
    // A refused connection is a failure of its own kind, with nothing of the address in it.
    const closed = await fake();
    await new Promise((resolve) => closed.server.close(resolve));
    expect(await kindOf(outbound(`http://localhost:${closed.port}/`, { allow: [own] }))).toBe(
      'failed',
    );
  });

  it('refuses an address that carries a user name or password', async () => {
    ok();
    expect(await kindOf(outbound(`http://me:pw@localhost:${a.port}/`, { allow: [own] }))).toBe(
      'failed',
    );
  });

  it('sends a body with a POST', async () => {
    let received = '';
    handler = (request, response) => {
      request.on('data', (chunk: Buffer) => (received += chunk.toString()));
      request.on('end', () => response.end('done'));
    };
    const response = await outbound(`http://localhost:${a.port}/`, {
      allow: [own],
      method: 'POST',
      body: 'payload',
    });
    expect(response.body.toString()).toBe('done');
    expect(received).toBe('payload');
  });
});
