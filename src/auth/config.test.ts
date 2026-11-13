import { describe, expect, it } from 'vitest';
import { loadConfig, type LoadResult } from '../config';
import { safeNext } from './config';

const BASE = {
  WAYMARK_ENCRYPTION_KEY: 'a'.repeat(64),
  WAYMARK_URL: 'https://waymark.example.com',
  WAYMARK_AUTH_SECRET: 'a-secret-that-is-at-least-thirty-two-characters-long',
};

const problems = (result: LoadResult): readonly string[] => {
  if (result.ok) throw new Error('the settings were accepted');
  return result.problems;
};

const authOf = (env: Record<string, string>) => {
  const result = loadConfig({ ...BASE, ...env });
  if (!result.ok) throw new Error(result.problems.join(' '));
  return result.config.auth;
};

describe('how people sign in', () => {
  it('is off when no way is on, and then needs nothing of the others', () => {
    const result = loadConfig({ WAYMARK_ENCRYPTION_KEY: BASE.WAYMARK_ENCRYPTION_KEY });
    expect(result).toMatchObject({ ok: true, config: { auth: undefined } });
  });

  it('local sign-in needs the address and a secret of 32 characters, and says so without a value', () => {
    const said = problems(
      loadConfig({ WAYMARK_ENCRYPTION_KEY: BASE.WAYMARK_ENCRYPTION_KEY, WAYMARK_AUTH_LOCAL: '1' }),
    ).join(' ');
    expect(said).toContain('WAYMARK_URL');
    expect(said).toContain('WAYMARK_AUTH_SECRET');
    const short = problems(
      loadConfig({ ...BASE, WAYMARK_AUTH_LOCAL: '1', WAYMARK_AUTH_SECRET: 'too-short-secret' }),
    );
    expect(short.join(' ')).toContain('at least 32 characters');
    expect(short.join(' ')).not.toContain('too-short-secret');
  });

  it('is by invitation with local sign-in unless it says otherwise, and open when a core is the only way in', () => {
    expect(authOf({ WAYMARK_AUTH_LOCAL: '1' })).toMatchObject({ local: true, signUp: 'invite' });
    expect(authOf({ WAYMARK_AUTH_LOCAL: '1', WAYMARK_AUTH_SIGNUP: 'closed' })).toMatchObject({
      signUp: 'closed',
    });
    expect(authOf({ WAYMARK_AUTH_LOCAL: '1', WAYMARK_AUTH_SIGNUP: 'open' })).toMatchObject({
      signUp: 'open',
    });
    const core = {
      WAYMARK_CORE_URL: 'https://core.example.com/',
      WAYMARK_CORE_CLIENT_ID: 'waymark',
      WAYMARK_CORE_CLIENT_SECRET: 'client-secret',
    };
    expect(authOf(core)).toMatchObject({
      local: false,
      signUp: 'open',
      sovereign: { issuer: 'https://core.example.com', clientId: 'waymark' },
    });
    // Both ways at once, as an instance hosts it: local sign-up keeps its own default.
    expect(authOf({ ...core, WAYMARK_AUTH_LOCAL: '1' })).toMatchObject({
      local: true,
      signUp: 'invite',
    });
  });

  it('takes `invite`, and refuses a sign-up policy it does not know', () => {
    expect(authOf({ WAYMARK_AUTH_LOCAL: '1', WAYMARK_AUTH_SIGNUP: 'invite' })).toMatchObject({
      signUp: 'invite',
    });
    expect(authOf({ WAYMARK_AUTH_LOCAL: '1', WAYMARK_AUTH_SIGNUP: 'INVITE' })?.signUp).toBe(
      'invite',
    );
    expect(
      problems(loadConfig({ ...BASE, WAYMARK_AUTH_LOCAL: '1', WAYMARK_AUTH_SIGNUP: 'anyone' }))[0],
    ).toContain('WAYMARK_AUTH_SIGNUP');
  });

  it('sends a person who signed in from an invitation back to it, and nowhere else', () => {
    const token = 'a'.repeat(43);
    expect(safeNext(`/invite/${token}`)).toBe(`/invite/${token}`);
    for (const hostile of [
      undefined,
      '',
      '/',
      '//evil.example.com',
      'https://evil.example.com/invite/' + token,
      `/invite/${token}/../../x`,
      `/invite/${token}?x=1`,
      '/invite/short',
      '/settings',
      ['/invite/' + token],
    ])
      expect(safeNext(hostile), String(hostile)).toBe('/');
  });

  it('reads the shortest password, 8 to 128, 10 by default', () => {
    expect(authOf({ WAYMARK_AUTH_LOCAL: '1' })?.passwordMinLength).toBe(10);
    expect(
      authOf({ WAYMARK_AUTH_LOCAL: '1', WAYMARK_AUTH_PASSWORD_MIN_LENGTH: '12' })
        ?.passwordMinLength,
    ).toBe(12);
    for (const value of ['7', '129', 'ten', '9.5'])
      expect(
        problems(
          loadConfig({ ...BASE, WAYMARK_AUTH_LOCAL: '1', WAYMARK_AUTH_PASSWORD_MIN_LENGTH: value }),
        )[0],
      ).toContain('WAYMARK_AUTH_PASSWORD_MIN_LENGTH');
  });

  it('allows a switch to be 1, true, 0 or false and nothing else', () => {
    expect(authOf({ WAYMARK_AUTH_LOCAL: 'true' })?.local).toBe(true);
    expect(problems(loadConfig({ ...BASE, WAYMARK_AUTH_LOCAL: 'yes' }))[0]).toContain(
      'WAYMARK_AUTH_LOCAL is 1 or 0',
    );
  });

  it('refuses a core that is not https (except on this machine), or carries credentials', () => {
    const core = { WAYMARK_CORE_CLIENT_ID: 'a', WAYMARK_CORE_CLIENT_SECRET: 'b' };
    for (const url of [
      'http://core.example.com',
      'https://u:p@core.example.com',
      'https://core.example.com/?x=1',
    ])
      expect(
        problems(loadConfig({ ...BASE, ...core, WAYMARK_CORE_URL: url })).join(' '),
      ).not.toContain(url);
    expect(authOf({ ...core, WAYMARK_CORE_URL: 'http://localhost:3000' })?.sovereign?.issuer).toBe(
      'http://localhost:3000',
    );
  });
});
