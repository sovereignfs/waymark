import { describe, expect, it } from 'vitest';
import { loadConfig } from '../config';

const KEY = { WAYMARK_ENCRYPTION_KEY: 'a'.repeat(64) };

describe('mail settings', () => {
  it('is off with no host, and the other mail settings are then not read', () => {
    expect(loadConfig({ ...KEY, WAYMARK_SMTP_PORT: 'nonsense' })).toMatchObject({
      ok: true,
      config: { mail: undefined },
    });
  });

  it('reads host, port 587 by default, sender and a user with a password', () => {
    const result = loadConfig({
      ...KEY,
      WAYMARK_SMTP_HOST: 'smtp.example.com',
      WAYMARK_SMTP_FROM: 'Waymark <waymark@example.com>',
      WAYMARK_SMTP_USER: 'u',
      WAYMARK_SMTP_PASSWORD: 'p',
    });
    expect(result).toMatchObject({
      ok: true,
      config: { mail: { host: 'smtp.example.com', port: 587, secure: false, user: 'u' } },
    });
    expect(
      loadConfig({
        ...KEY,
        WAYMARK_SMTP_HOST: 'smtp.example.com',
        WAYMARK_SMTP_FROM: 'a@example.com',
        WAYMARK_SMTP_PORT: '465',
      }),
    ).toMatchObject({ config: { mail: { port: 465, secure: true } } });
  });

  it('stops on a wrong host, port, sender, or a user without a password, never printing the password', () => {
    const base = {
      ...KEY,
      WAYMARK_SMTP_HOST: 'smtp.example.com',
      WAYMARK_SMTP_FROM: 'a@example.com',
    };
    const said = (extra: Record<string, string>) => {
      const result = loadConfig({ ...base, ...extra });
      return result.ok ? '' : result.problems.join(' ');
    };
    expect(said({ WAYMARK_SMTP_HOST: 'https://smtp.example.com' })).toContain('WAYMARK_SMTP_HOST');
    expect(said({ WAYMARK_SMTP_PORT: '70000' })).toContain('WAYMARK_SMTP_PORT');
    expect(said({ WAYMARK_SMTP_FROM: 'not an address' })).toContain('WAYMARK_SMTP_FROM');
    const lone = said({ WAYMARK_SMTP_PASSWORD: 'hunter2' });
    expect(lone).toContain('both or neither');
    expect(lone).not.toContain('hunter2');
  });
});
