import { describe, expect, it } from 'vitest';
import { contrast, luminance, readableOn } from './contrast';

describe('the text on a colour a person or a trip has', () => {
  it('is black on a light colour and white on a dark one', () => {
    expect(readableOn('#ffffff')).toBe('#000000');
    expect(readableOn('#fde68a')).toBe('#000000');
    expect(readableOn('#000000')).toBe('#ffffff');
    expect(readableOn('#1e3a8a')).toBe('#ffffff');
  });

  it('measures luminance and contrast as WCAG does', () => {
    expect(luminance('#000000')).toBe(0);
    expect(luminance('#ffffff')).toBeCloseTo(1, 5);
    expect(contrast('#000000', '#ffffff')).toBeCloseTo(21, 3);
    expect(contrast('#777777', '#777777')).toBeCloseTo(1, 5);
  });

  it('takes what is not a colour for black, and so puts white on it', () => {
    expect(luminance('blue')).toBe(0);
    expect(readableOn('not a colour')).toBe('#ffffff');
  });
});
