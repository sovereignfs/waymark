import { describe, expect, it } from 'vitest';
import { SECTIONS, one, sectionOf } from './query';

describe('which section of Settings an address asks for', () => {
  it('opens the one that exists, and Profile for anything else', () => {
    for (const section of SECTIONS) expect(sectionOf(section)).toBe(section);
    for (const asked of [
      undefined,
      '',
      'nonsense',
      'PROFILE',
      '__proto__',
      'security ',
      '../data',
      'notifications',
      'device ',
    ])
      expect(sectionOf(asked), String(asked)).toBe('profile');
  });

  it('takes the first value of a parameter, and nothing of an array or of nothing', () => {
    expect(one('data')).toBe('data');
    expect(one(['a', 'b'])).toBeUndefined();
    expect(one(undefined)).toBeUndefined();
  });
});
