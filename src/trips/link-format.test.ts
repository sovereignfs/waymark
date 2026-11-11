import { describe, expect, it } from 'vitest';
import { LINK_URL_MAX, TALLY_TITLE, checkLink, cleanLinkUrl } from './link-format';

/** What a link may be (DESIGN.md §10.7): an https address and nothing else. */
describe('a link’s address', () => {
  it('is an https address, kept as the parser writes it', () => {
    expect(cleanLinkUrl('https://tally.example.org/g/abc123')).toEqual({
      ok: true,
      value: 'https://tally.example.org/g/abc123',
    });
    expect(cleanLinkUrl('  HTTPS://Tally.Example.ORG/g/abc?x=1#top  ')).toEqual({
      ok: true,
      value: 'https://tally.example.org/g/abc?x=1#top',
    });
    expect(cleanLinkUrl('https://example.org')).toEqual({
      ok: true,
      value: 'https://example.org/',
    });
    expect(cleanLinkUrl('https://xn--bcher-kva.example/')).toMatchObject({ ok: true });
    expect(cleanLinkUrl('https://192.0.2.1:8443/a')).toMatchObject({ ok: true });
  });

  it('is refused for every other scheme, whatever it is dressed as', () => {
    for (const bad of [
      'http://example.org',
      'javascript:alert(1)',
      'JavaScript:alert(1)',
      ' javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'file:///etc/passwd',
      'ftp://example.org/x',
      'mailto:a@example.org',
      'tel:+351123',
      'vbscript:x',
      'blob:https://example.org/uuid',
      '//example.org/x',
      'example.org',
      'www.example.org/x',
      '/relative/path',
      'https:example.org',
      'https:///nohost',
      'https://',
    ])
      expect(cleanLinkUrl(bad), bad).toMatchObject({ ok: false });
  });

  it('is refused with a name or password in it, a space or a control character in it, or too long, and for anything that is not text', () => {
    for (const bad of [
      'https://user@example.org/',
      'https://user:secret@example.org/',
      'https://exa mple.org/',
      'https://example.org/a b',
      'https://example.org/a\nb',
      'https://example.org/\u0000',
      'https://example.org/​'.replace('​', '\u0085'),
      `https://example.org/${'a'.repeat(LINK_URL_MAX)}`,
      '',
      '   ',
    ])
      expect(cleanLinkUrl(bad), JSON.stringify(bad).slice(0, 40)).toMatchObject({ ok: false });
    for (const notText of [null, undefined, 5, {}, [], ['https://example.org']])
      expect(cleanLinkUrl(notText)).toMatchObject({ ok: false });
  });

  it('says what is wrong without repeating what was typed', () => {
    const refused = cleanLinkUrl('javascript:alert("my secret")');
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.sentence).not.toContain('secret');
      expect(refused.sentence).not.toContain('alert');
    }
    const withPassword = cleanLinkUrl('https://ada:hunter2@example.org/');
    if (!withPassword.ok) expect(withPassword.sentence).not.toContain('hunter2');
  });
});

describe('a link', () => {
  it('has a kind, other when none is given, a title and an address', () => {
    expect(checkLink({ title: 'Hotel', url: 'https://example.org/h' })).toEqual({
      ok: true,
      value: { kind: 'other', title: 'Hotel', url: 'https://example.org/h' },
    });
    expect(
      checkLink({ kind: 'tally', title: 'Our money', url: 'https://tally.example.org/g/1' }),
    ).toMatchObject({ ok: true, value: { kind: 'tally', title: 'Our money' } });
  });

  it('calls a Tally link what it is when the title is left out, and needs a title for any other', () => {
    for (const title of [undefined, null, ''])
      expect(
        checkLink({ kind: 'tally', title, url: 'https://tally.example.org/g/1' }),
      ).toMatchObject({ ok: true, value: { title: TALLY_TITLE } });
    for (const title of [undefined, null, '', '   '])
      expect(checkLink({ title, url: 'https://example.org/' }), String(title)).toMatchObject({
        ok: false,
      });
  });

  it('refuses a kind that is not one, a title that is not one line of up to 120 characters, and an address that is not https', () => {
    expect(checkLink({ kind: 'splitwise', title: 'x', url: 'https://example.org/' })).toMatchObject(
      { ok: false },
    );
    expect(checkLink({ title: 'x'.repeat(121), url: 'https://example.org/' })).toMatchObject({
      ok: false,
    });
    expect(checkLink({ title: 'a\nb', url: 'https://example.org/' })).toMatchObject({ ok: false });
    expect(checkLink({ title: 5, url: 'https://example.org/' })).toMatchObject({ ok: false });
    expect(checkLink({ title: 'x', url: 'http://example.org/' })).toMatchObject({ ok: false });
    expect(checkLink({ title: 'x' })).toMatchObject({ ok: false });
  });
});
