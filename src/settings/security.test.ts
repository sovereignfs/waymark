import { describe, expect, it } from 'vitest';
import { deviceName } from './SecuritySection';

describe('the name of a device', () => {
  it('is the browser and the system a person would say, from the browser’s own words', () => {
    const chrome =
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
    const safari =
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
    const firefox = 'Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0';
    const edge =
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0';
    expect(deviceName(chrome)).toBe('Chrome on macOS');
    expect(deviceName(safari)).toBe('Safari on iOS');
    expect(deviceName(firefox)).toBe('Firefox on Linux');
    expect(deviceName(edge)).toBe('Chrome on Windows');
  });

  it('is plain for what it cannot tell, and never repeats the string', () => {
    expect(deviceName(null)).toBe('An unknown device');
    expect(deviceName('')).toBe('An unknown device');
    expect(deviceName('curl/8.0')).toBe('A browser');
    expect(deviceName('<script>alert(1)</script>')).not.toContain('script');
  });
});
