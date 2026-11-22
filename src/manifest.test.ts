import { describe, expect, it } from 'vitest';
import manifest from '@/app/manifest';

describe('the web app manifest', () => {
  it('keeps the identity existing installs have: the id is the start address', () => {
    const made = manifest();
    expect(made.id).toBe('/');
    expect(made.start_url).toBe('/');
  });

  it('lets a link into the app open the installed app, on the page it names', () => {
    expect(manifest()).toMatchObject({
      launch_handler: { client_mode: ['navigate-existing', 'auto'] },
      handle_links: 'preferred',
      display: 'standalone',
      scope: '/',
    });
  });

  it('names an icon drawn to be masked, beside the plain ones', () => {
    expect(manifest().icons?.map((icon) => icon.purpose)).toEqual(['any', 'any', 'maskable']);
  });
});
