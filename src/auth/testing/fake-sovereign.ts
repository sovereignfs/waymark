import { createHash, randomBytes } from 'node:crypto';
import { type Server, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { type FakeCore, createFakeCore } from '@sovereignfs/sdk/testing';
import { type CryptoKey, SignJWT, exportJWK, generateKeyPair } from 'jose';

/**
 * A stand-in for a Sovereign instance's OIDC provider (RFC 0072), as much of it as Waymark uses:
 * discovery, the signing keys, the authorization endpoint (which signs in whoever the test says
 * is "at the keyboard" without a screen), the token endpoint and userinfo. It is strict where
 * Sovereign is: a redirect URI is matched exactly, PKCE is S256 and checked, the client signs in
 * with its secret, and a code works once. The ID token is EdDSA, as Sovereign's is.
 *
 * **It is also a core for what an app does as a person** (DESIGN.md §19.3): the SDK's own fake core (`createFakeCore`) answers behind it, so that a sign-in with `offline_access` is given a refresh token, the SDK's
 * refresh and app-token grants are served at the token endpoint, and `/api/v1/*` (the directory) and the documents the SDK reads first are there. The people of its directory are the ones signed in and those a test adds
 * (`core.addPerson`).
 *
 * Its discovery document has the shape of the one recorded from a real instance
 * (`fixtures/sovereign-discovery.json`, checked against this in `sovereign-discovery.test.ts`), so a
 * change on Sovereign's side shows up there and not in a user's sign-in.
 */
export interface FakeUser {
  sub: string;
  email: string;
  name?: string;
  emailVerified?: boolean;
}

export interface FakeSovereignOptions {
  clientId?: string;
  clientSecret?: string;
  /** A port to listen on, for an instance that is started by hand; by default a free one. */
  port?: number;
  /** Discovery fields to leave out, to see how a client copes with a document that is missing them. */
  omitFromDiscovery?: string[];
}

export interface LoginOverrides {
  /** Claims placed in the ID token on top of the user's. */
  claims?: Record<string, unknown>;
  /** Sign the ID token with a key that is not in the published set. */
  signWithWrongKey?: boolean;
  /** Leave the `nonce` out of the ID token. */
  omitNonce?: boolean;
}

interface Pending {
  clientId: string;
  redirectUri: string;
  challenge: string;
  nonce: string | undefined;
  user: FakeUser;
  overrides: LoginOverrides;
  scope: string;
  used: boolean;
}

export interface FakeSovereign {
  /** e.g. http://localhost:41234/api/auth */
  issuer: string;
  clientId: string;
  clientSecret: string;
  /** Who the next login at the authorization endpoint is. */
  signInAs(user: FakeUser, overrides?: LoginOverrides): void;
  /** Answer the next authorization request with a refusal, the way a person clicking Deny would. */
  denyNext(): void;
  /**
   * A signed notice, as Sovereign sends an app when a person's session ends (\`logout\`: the back-channel logout token of OpenID Connect) or they delete their
   * account (\`account-deleted\`): typed, for this client, good for two minutes, with a \`jti\` of its own, signed with the key it publishes. Core's carry the
   * \`sub\` and the \`sid\`. \`wrong\` makes one that is wrong in one way, for testing that an app refuses it.
   */
  noticeToken(
    kind: 'logout' | 'account-deleted',
    who: { sub?: string; sid?: string },
    wrong?: 'signature' | 'audience' | 'expired' | 'type',
  ): Promise<string>;
  /** The SDK's fake core behind this provider: the directory's people, the notifications and emails it was asked to send, and what it saw. */
  core: FakeCore;
  /** The authorization requests received, newest last. */
  authorizations: URL[];
  /** The access tokens handed out, so a test can look for them where they must not be. */
  accessTokensIssued: string[];
  /** The token requests received: the headers and the form, newest last. */
  tokenRequests: { authorization: string | undefined; form: URLSearchParams }[];
  close(): Promise<void>;
}

const PATH = '/api/auth';

export async function startFakeSovereign(
  options: FakeSovereignOptions = {},
): Promise<FakeSovereign> {
  const clientId = options.clientId ?? 'waymark-test-client';
  const clientSecret = options.clientSecret ?? 'waymark-test-secret';
  const { publicKey, privateKey } = await generateKeyPair('EdDSA', {
    crv: 'Ed25519',
    extractable: true,
  });
  const other = await generateKeyPair('EdDSA', { crv: 'Ed25519' });
  const kid = 'test-key-1';
  const jwk = { ...(await exportJWK(publicKey)), kid, alg: 'EdDSA', use: 'sig' };

  const codes = new Map<string, Pending>();
  const accessTokens = new Map<string, FakeUser>();
  const accessTokensIssued: string[] = [];
  let next: { user: FakeUser; overrides: LoginOverrides } | undefined;
  let deny = false;
  const authorizations: URL[] = [];
  const tokenRequests: FakeSovereign['tokenRequests'] = [];
  let issuer = '';
  // The core behind the provider is made once the port is known (its address is the provider's origin).
  const behind: { core?: FakeCore } = {};

  const sign = (key: CryptoKey, claims: Record<string, unknown>) =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: 'EdDSA', kid })
      .setIssuedAt()
      .setExpirationTime('10m')
      .sign(key);

  const noticeToken: FakeSovereign['noticeToken'] = async (kind, who, wrong) => {
    const event =
      kind === 'logout'
        ? 'http://schemas.openid.net/event/backchannel-logout'
        : 'urn:sovereignfs:event:account-deleted';
    const issued = Math.floor(Date.now() / 1000);
    return new SignJWT({
      ...(who.sub ? { sub: who.sub } : {}),
      ...(who.sid ? { sid: who.sid } : {}),
      events: { [event]: {} },
    })
      .setProtectedHeader({
        alg: 'EdDSA',
        kid,
        typ: wrong === 'type' ? 'JWT' : kind === 'logout' ? 'logout+jwt' : 'account-deleted+jwt',
      })
      .setIssuer(issuer)
      .setAudience(wrong === 'audience' ? 'another-app' : clientId)
      .setIssuedAt(issued)
      .setExpirationTime(wrong === 'expired' ? issued - 10 : issued + 120)
      .setJti(randomBytes(12).toString('hex'))
      .sign(wrong === 'signature' ? other.privateKey : privateKey);
  };

  const server: Server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', issuer || 'http://localhost');
      const json = (status: number, body: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      try {
        if (url.pathname === `${PATH}/.well-known/openid-configuration`) {
          const document: Record<string, unknown> = {
            issuer,
            authorization_endpoint: `${issuer}/oauth2/authorize`,
            token_endpoint: `${issuer}/oauth2/token`,
            jwks_uri: `${issuer}/jwks`,
            userinfo_endpoint: `${issuer}/oauth2/userinfo`,
            end_session_endpoint: `${issuer}/oauth2/end-session`,
            scopes_supported: ['openid', 'profile', 'email', 'offline_access'],
            response_types_supported: ['code'],
            response_modes_supported: ['query'],
            grant_types_supported: ['authorization_code', 'client_credentials', 'refresh_token'],
            token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
            code_challenge_methods_supported: ['S256'],
            authorization_response_iss_parameter_supported: true,
            subject_types_supported: ['public'],
            id_token_signing_alg_values_supported: ['EdDSA'],
          };
          for (const field of options.omitFromDiscovery ?? [])
            Reflect.deleteProperty(document, field);
          return json(200, document);
        }
        if (url.pathname === `${PATH}/jwks`) return json(200, { keys: [jwk] });

        // What the SDK asks of a core: its documents at the root, the Core API, and the grants that are not a sign-in's code (a refresh, and the app's own token).
        let tokenBody: string | undefined;
        const core = behind.core;
        if (core) {
          const delegate =
            url.pathname === '/.well-known/openid-configuration' ||
            url.pathname === '/.well-known/sovereign-instance' ||
            url.pathname.startsWith('/api/v1/');
          let body: string | undefined;
          let grant: string | null = null;
          if (req.method === 'POST' && url.pathname === `${PATH}/oauth2/token`) {
            body = tokenBody = await readBody(req);
            grant = new URLSearchParams(body).get('grant_type');
          }
          if (delegate || (grant !== null && grant !== 'authorization_code')) {
            if (body === undefined && req.method !== 'GET' && req.method !== 'HEAD')
              body = await readBody(req);
            const answer = await core.fetch(
              new Request(new URL(url.pathname + url.search, core.url), {
                method: req.method,
                headers: Object.fromEntries(
                  Object.entries(req.headers).filter(
                    (entry): entry is [string, string] => typeof entry[1] === 'string',
                  ),
                ),
                ...(body !== undefined ? { body } : {}),
              }),
            );
            res.writeHead(answer.status, Object.fromEntries(answer.headers));
            return void res.end(await answer.text());
          }
        }

        if (url.pathname === `${PATH}/oauth2/authorize`) {
          authorizations.push(url);
          const q = url.searchParams;
          const redirectUri = q.get('redirect_uri') ?? '';
          // Not a redirect to an unregistered address, whatever else is wrong: tell the person.
          if (
            q.get('client_id') !== clientId ||
            !redirectUri.endsWith('/api/auth/callback/sovereign')
          ) {
            res.writeHead(400, { 'content-type': 'text/plain' });
            return void res.end('invalid_client or redirect_uri');
          }
          const back = new URL(redirectUri);
          const state = q.get('state');
          if (state) back.searchParams.set('state', state);
          back.searchParams.set('iss', issuer);
          if (deny) {
            deny = false;
            back.searchParams.set('error', 'access_denied');
          } else if (
            q.get('response_type') !== 'code' ||
            q.get('code_challenge_method') !== 'S256' ||
            !q.get('code_challenge') ||
            !next
          ) {
            back.searchParams.set('error', 'invalid_request');
          } else {
            const code = randomBytes(16).toString('hex');
            codes.set(code, {
              clientId,
              redirectUri,
              challenge: q.get('code_challenge') as string,
              nonce: q.get('nonce') ?? undefined,
              user: next.user,
              overrides: next.overrides,
              scope: q.get('scope') ?? 'openid',
              used: false,
            });
            back.searchParams.set('code', code);
          }
          res.writeHead(302, { location: back.toString() });
          return void res.end();
        }

        if (url.pathname === `${PATH}/oauth2/token` && req.method === 'POST') {
          const form = new URLSearchParams(tokenBody ?? (await readBody(req)));
          tokenRequests.push({ authorization: req.headers.authorization, form });
          const basic = /^Basic (.+)$/.exec(req.headers.authorization ?? '')?.[1];
          const [id, secret] = basic
            ? Buffer.from(basic, 'base64').toString().split(':').map(decodeURIComponent)
            : [form.get('client_id'), form.get('client_secret')];
          if (id !== clientId || secret !== clientSecret)
            return json(401, { error: 'invalid_client' });
          const pending = codes.get(form.get('code') ?? '');
          if (
            !pending ||
            pending.used ||
            form.get('grant_type') !== 'authorization_code' ||
            form.get('redirect_uri') !== pending.redirectUri
          ) {
            return json(400, { error: 'invalid_grant' });
          }
          pending.used = true;
          const verifier = form.get('code_verifier') ?? '';
          if (createHash('sha256').update(verifier).digest('base64url') !== pending.challenge)
            return json(400, { error: 'invalid_grant', error_description: 'PKCE' });

          const accessToken = randomBytes(24).toString('hex');
          accessTokens.set(accessToken, pending.user);
          accessTokensIssued.push(accessToken);
          const { user, overrides } = pending;
          const idToken = await sign(overrides.signWithWrongKey ? other.privateKey : privateKey, {
            iss: issuer,
            aud: clientId,
            sub: user.sub,
            email: user.email,
            email_verified: user.emailVerified ?? true,
            ...(user.name !== undefined ? { name: user.name } : {}),
            ...(pending.nonce && !overrides.omitNonce ? { nonce: pending.nonce } : {}),
            ...overrides.claims,
          });
          // With `offline_access` the person is a person of the directory and is given a refresh token the SDK can use (the fake core rotates it, as core does).
          let refreshToken: string | undefined;
          if (behind.core && pending.scope.split(' ').includes('offline_access')) {
            behind.core.addPerson({ sub: user.sub, name: user.name ?? user.email });
            refreshToken = behind.core.signIn(user.sub);
          }
          return json(200, {
            access_token: accessToken,
            token_type: 'Bearer',
            expires_in: 3600,
            scope: pending.scope,
            id_token: idToken,
            ...(refreshToken ? { refresh_token: refreshToken } : {}),
          });
        }

        if (url.pathname === `${PATH}/oauth2/userinfo`) {
          const user = accessTokens.get(
            /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1] ?? '',
          );
          if (!user) return json(401, { error: 'invalid_token' });
          return json(200, {
            sub: user.sub,
            email: user.email,
            email_verified: user.emailVerified ?? true,
            ...(user.name !== undefined ? { name: user.name } : {}),
          });
        }
        json(404, { error: 'not_found' });
      } catch (error) {
        json(500, { error: String(error) });
      }
    })();
  });

  await new Promise<void>((resolve) => server.listen(options.port ?? 0, resolve));
  issuer = `http://localhost:${(server.address() as AddressInfo).port}${PATH}`;
  const core = createFakeCore({ url: new URL(issuer).origin, clientId, clientSecret });
  behind.core = core;

  return {
    issuer,
    clientId,
    clientSecret,
    noticeToken,
    core,
    signInAs: (user, overrides = {}) => void (next = { user, overrides }),
    denyNext: () => void (deny = true),
    authorizations,
    accessTokensIssued,
    tokenRequests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function readBody(req: NodeJS.ReadableStream): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}
