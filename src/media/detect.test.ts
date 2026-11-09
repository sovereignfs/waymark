import { describe, expect, it } from 'vitest';
import { allowed, detect } from './detect';

const bytes = (...values: number[]) => new Uint8Array(values);
const ascii = (text: string) => new TextEncoder().encode(text);
const box = (brand: string) =>
  new Uint8Array([0, 0, 0, 24, ...ascii('ftyp'), ...ascii(brand), 0, 0, 0, 0, ...ascii('mif1')]);

describe('a file is what its bytes say', () => {
  it.each([
    ['jpeg', bytes(0xff, 0xd8, 0xff, 0xe0, 0, 0x10)],
    ['png', bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0)],
    ['webp', new Uint8Array([...ascii('RIFF'), 1, 2, 3, 4, ...ascii('WEBP'), 0])],
    ['gif', ascii('GIF89a\u0001\u0000')],
    ['pdf', ascii('%PDF-1.7\n')],
    ['zip', bytes(0x50, 0x4b, 0x03, 0x04, 0x14, 0)],
    ['avif', box('avif')],
    ['heic', box('heic')],
    ['heic', box('mif1')],
  ] as const)('reads %s', (format, content) => expect(detect(content)).toBe(format));

  it('reads nothing of a page, a script, text, an empty file or what it does not know', () => {
    for (const content of [
      ascii('<!doctype html><script>alert(1)</script>'),
      ascii('<html><body>not an image</body></html>'),
      ascii('<?php echo 1;'),
      ascii('#!/bin/sh\nrm -rf /'),
      ascii('GIF'),
      new Uint8Array(),
      ascii('{"json": true}'),
      ascii('<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>'),
    ])
      expect(detect(content)).toBeUndefined();
  });

  it('does not take a name or a claimed type into account: there is none to give', () => {
    // An HTML page "named .jpg" is the same bytes as any HTML page.
    expect(detect(ascii('<html>photo.jpg</html>'))).toBeUndefined();
  });

  it('allows each kind only what is on its list', () => {
    expect(allowed('photo', 'jpeg')).toBe(true);
    expect(allowed('photo', 'pdf')).toBe(false);
    expect(allowed('photo', 'zip')).toBe(false);
    expect(allowed('attachment', 'pdf')).toBe(true);
    expect(allowed('attachment', 'zip')).toBe(false);
    expect(allowed('import', 'zip')).toBe(true);
    expect(allowed('import', 'jpeg')).toBe(false);
    expect(allowed('thumb', 'webp')).toBe(false);
    expect(allowed('photo', undefined)).toBe(false);
  });
});
