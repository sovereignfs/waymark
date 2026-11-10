import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { thumbIdOf } from './files';
import { thumbIdAsync } from './thumb';

describe('a photo’s thumbnail id, on the device and on the server', () => {
  it('is the same one, for every photo', async () => {
    for (let i = 0; i < 200; i++) {
      const id = randomUUID();
      expect(await thumbIdAsync(id), id).toBe(thumbIdOf(id));
    }
    expect(await thumbIdAsync('11111111-1111-4111-8111-111111111111')).toBe(
      thumbIdOf('11111111-1111-4111-8111-111111111111'),
    );
  });

  it('is a UUID, and not the photo’s own', async () => {
    const id = randomUUID();
    const thumb = await thumbIdAsync(id);
    expect(thumb).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(thumb).not.toBe(id);
  });
});
