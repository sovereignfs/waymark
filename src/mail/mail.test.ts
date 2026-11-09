import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../config';
import { MemoryMailer } from './memory';
import { SmtpSink } from './testing/smtp-sink';
import { resolveMail } from './config';
import { smtpMailer } from './smtp';
import { resetMessage, verificationMessage } from './templates';

/** Mail (DESIGN.md §6): its settings, its two mailers, and the messages. Optional: no host, no mail. */
const settings = (env: Record<string, string | undefined>) => {
  const problems: string[] = [];
  const mail = resolveMail((name) => env[name] || undefined, problems);
  return { mail, problems };
};

describe('the mail settings', () => {
  it('are none without a host, and the rest are then not read', () => {
    expect(settings({})).toEqual({ mail: undefined, problems: [] });
    expect(settings({ WAYMARK_SMTP_PORT: 'banana', WAYMARK_SMTP_FROM: '' })).toEqual({
      mail: undefined,
      problems: [],
    });
  });

  it('take a host with a sender, 587 by default, and 465 as encrypted from the start', () => {
    expect(
      settings({
        WAYMARK_SMTP_HOST: 'smtp.example.com',
        WAYMARK_SMTP_FROM: 'Waymark <waymark@example.com>',
      }).mail,
    ).toEqual({
      host: 'smtp.example.com',
      port: 587,
      secure: false,
      user: undefined,
      password: undefined,
      from: 'Waymark <waymark@example.com>',
    });
    expect(
      settings({
        WAYMARK_SMTP_HOST: 'smtp.example.com',
        WAYMARK_SMTP_PORT: '465',
        WAYMARK_SMTP_FROM: 'waymark@example.com',
        WAYMARK_SMTP_USER: 'u',
        WAYMARK_SMTP_PASSWORD: 'p',
      }).mail,
    ).toMatchObject({ port: 465, secure: true, user: 'u', password: 'p' });
  });

  it('stop the server for a host with no sender, a user without a password, a port that is not one, a host with a scheme, and a sender that is not an address, and name no value', () => {
    for (const env of [
      { WAYMARK_SMTP_HOST: 'smtp.example.com' },
      {
        WAYMARK_SMTP_HOST: 'smtp.example.com',
        WAYMARK_SMTP_FROM: 'waymark@example.com',
        WAYMARK_SMTP_USER: 'u',
      },
      {
        WAYMARK_SMTP_HOST: 'smtp.example.com',
        WAYMARK_SMTP_FROM: 'waymark@example.com',
        WAYMARK_SMTP_PORT: '0',
      },
      { WAYMARK_SMTP_HOST: 'smtps://smtp.example.com', WAYMARK_SMTP_FROM: 'waymark@example.com' },
      { WAYMARK_SMTP_HOST: 'smtp.example.com', WAYMARK_SMTP_FROM: 'not an address' },
      { WAYMARK_SMTP_HOST: 'smtp.example.com', WAYMARK_SMTP_FROM: 'a@b.c\r\nBcc: x@y.z' },
    ]) {
      const { mail, problems } = settings(env);
      expect(mail, JSON.stringify(env)).toBeUndefined();
      expect(problems.length, JSON.stringify(env)).toBeGreaterThan(0);
      expect(problems.join(' ')).not.toContain('Bcc');
    }
  });

  it('are read through the whole configuration, the password from a file too', () => {
    const base = {
      WAYMARK_ENCRYPTION_KEY: 'a'.repeat(64),
      WAYMARK_SMTP_HOST: 'smtp.example.com',
      WAYMARK_SMTP_FROM: 'waymark@example.com',
      WAYMARK_SMTP_USER: 'u',
    };
    const result = loadConfig(
      { ...base, WAYMARK_SMTP_PASSWORD_FILE: '/run/secrets/smtp' },
      (path) => (path === '/run/secrets/smtp' ? 'from a file\n' : ''),
    );
    expect(result).toMatchObject({
      ok: true,
      config: { mail: { host: 'smtp.example.com', password: 'from a file' } },
    });
    expect(loadConfig({ WAYMARK_ENCRYPTION_KEY: 'a'.repeat(64) }, () => '')).toMatchObject({
      ok: true,
      config: { mail: undefined },
    });
    const bad = loadConfig({
      WAYMARK_ENCRYPTION_KEY: 'a'.repeat(64),
      WAYMARK_SMTP_HOST: 'smtp.example.com',
    });
    expect(bad.ok).toBe(false);
  });
});

describe('the messages', () => {
  it('each hold one link and say what it does, and nothing of the account but the address they go to', () => {
    const link = 'https://waymark.example/api/auth/verify-email?token=abc';
    const v = verificationMessage('Waymark', 'ada@example.com', link);
    expect(v).toMatchObject({ to: 'ada@example.com' });
    expect(v.text.match(/https?:\/\/\S+/g)).toEqual([link]);
    const r = resetMessage('Waymark', 'ada@example.com', 'https://waymark.example/reset?token=abc');
    expect(r.text).toContain('used once');
    expect(r.text).toContain('signs you out everywhere else');
    for (const m of [v, r]) expect(m.subject + m.text).not.toMatch(/password:|secret/i);
  });
});

describe('the memory mailer', () => {
  it('keeps what it is given, finds the last link to an address, and can be made to fail', async () => {
    const mailer = new MemoryMailer();
    await mailer.send(verificationMessage('Waymark', 'ada@example.com', 'https://x.example/one'));
    await mailer.send(verificationMessage('Waymark', 'Ada@Example.com', 'https://x.example/two'));
    expect(mailer.linkTo('ada@example.com')).toBe('https://x.example/two');
    expect(mailer.linkTo('nobody@example.com')).toBeUndefined();
    mailer.failNext = 1;
    await expect(mailer.send(resetMessage('Waymark', 'a@b.c', 'https://x'))).rejects.toThrow();
    expect(mailer.sent).toHaveLength(2);
  });
});

describe('the SMTP mailer', () => {
  let sink: SmtpSink;
  beforeAll(async () => {
    sink = await SmtpSink.start();
  });
  afterAll(async () => sink.stop());

  it('sends a message to a real SMTP server as the sender it was given, with the link in it', async () => {
    const mailer = smtpMailer({
      host: '127.0.0.1',
      port: sink.port,
      secure: false,
      user: undefined,
      password: undefined,
      from: 'Waymark <waymark@example.com>',
    });
    await mailer.send(
      resetMessage(
        'Waymark',
        'ada@example.com',
        'https://waymark.example/reset-password/abc123?x=1',
      ),
    );
    expect(sink.received).toHaveLength(1);
    const got = sink.received[0];
    expect(got?.from).toBe('waymark@example.com');
    expect(got?.to).toEqual(['ada@example.com']);
    expect(got?.data).toContain('Subject: Reset your Waymark password');
    expect(got?.data).toContain('From: Waymark <waymark@example.com>');
    // A message is quoted-printable on the wire: the soft line breaks and =3D are undone before the link is looked for.
    const body = (got?.data ?? '')
      .replace(/=\n/g, '')
      .replace(/=([0-9A-F]{2})/g, (_, hex: string) =>
        String.fromCharCode(Number.parseInt(hex, 16)),
      );
    expect(body).toContain('https://waymark.example/reset-password/abc123?x=1');
  });

  it('fails, without hanging, when there is no server to speak to', async () => {
    const mailer = smtpMailer({
      host: '127.0.0.1',
      port: 1,
      secure: false,
      user: undefined,
      password: undefined,
      from: 'waymark@example.com',
    });
    await expect(mailer.send(resetMessage('Waymark', 'a@b.c', 'https://x'))).rejects.toThrow();
  });
});
