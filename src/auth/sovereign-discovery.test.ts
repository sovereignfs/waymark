import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFakeSovereign } from './testing/fake-sovereign';
import type { FakeSovereign } from './testing/fake-sovereign';

/**
 * Ties the fake Sovereign to the real one. `fixtures/sovereign-discovery.json` is what a real
 * instance published (`node scripts/record-sovereign-discovery.mjs`), and Waymark's sign-in is
 * built on four things in it: where to send people, how to check an ID token, how the client
 * proves itself, and what Sovereign says about a person. If a re-recording breaks one of these,
 * the sign-in is what would have broken; if the fake stops agreeing with the recording, the other
 * tests have stopped proving anything about the real service.
 */
const recorded = JSON.parse(
  readFileSync(new URL('./fixtures/sovereign-discovery.json', import.meta.url), 'utf8'),
) as Record<string, unknown>;

describe("what Waymark relies on in a real Sovereign's discovery document", () => {
  it('publishes the endpoints sign-in uses, under its issuer', () => {
    const issuer = recorded.issuer as string;
    for (const field of [
      'authorization_endpoint',
      'token_endpoint',
      'jwks_uri',
      'userinfo_endpoint',
    ]) {
      expect(recorded[field], field).toEqual(expect.stringMatching(/^https:\/\//));
      expect(recorded[field] as string, field).toContain(new URL(issuer).origin);
    }
  });

  it('signs ID tokens with EdDSA, and allows the code flow with PKCE S256', () => {
    expect(recorded.id_token_signing_alg_values_supported).toContain('EdDSA');
    expect(recorded.response_types_supported).toContain('code');
    expect(recorded.code_challenge_methods_supported).toContain('S256');
    expect(recorded.grant_types_supported).toContain('authorization_code');
  });

  it('takes the client secret by basic auth, as Waymark sends it', () => {
    expect(recorded.token_endpoint_auth_methods_supported).toContain('client_secret_basic');
  });

  it('offers the scopes and the claims Waymark uses: sub, email, name', () => {
    expect(recorded.scopes_supported).toEqual(
      expect.arrayContaining(['openid', 'profile', 'email']),
    );
    expect(recorded.claims_supported).toEqual(expect.arrayContaining(['sub', 'email', 'name']));
  });
});

describe('the fake Sovereign agrees with it', () => {
  let fake: FakeSovereign;
  let served: Record<string, unknown>;
  beforeAll(async () => {
    fake = await startFakeSovereign();
    served = (await (
      await fetch(`${fake.issuer}/.well-known/openid-configuration`)
    ).json()) as Record<string, unknown>;
  });
  afterAll(async () => fake.close());

  it('publishes every field Waymark reads, with the same values for the ones that are about capability', () => {
    for (const field of [
      'authorization_endpoint',
      'token_endpoint',
      'jwks_uri',
      'userinfo_endpoint',
      'end_session_endpoint',
      'issuer',
    ]) {
      expect(served[field], field).toEqual(expect.any(String));
    }
    for (const field of [
      'id_token_signing_alg_values_supported',
      'code_challenge_methods_supported',
      'response_types_supported',
      'token_endpoint_auth_methods_supported',
    ]) {
      expect(served[field], field).toEqual(recorded[field]);
    }
  });

  it('serves each endpoint at the path the real one uses, relative to the issuer', () => {
    const relative = (doc: Record<string, unknown>, field: string) =>
      (doc[field] as string).slice((doc.issuer as string).length);
    for (const field of [
      'authorization_endpoint',
      'token_endpoint',
      'jwks_uri',
      'userinfo_endpoint',
    ]) {
      expect(relative(served, field), field).toBe(relative(recorded, field));
    }
  });
});
