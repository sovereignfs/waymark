import { describe, expect, it } from 'vitest';
import { THEME_KEY, chooseTheme, readTheme, themeOf } from './preferences';
import { themeScript } from './script';

const memory = (initial: Record<string, string> = {}) => {
  const data = { ...initial };
  return {
    data,
    getItem: (key: string) => data[key] ?? null,
    setItem: (key: string, value: string) => void (data[key] = value),
    removeItem: (key: string) => void Reflect.deleteProperty(data, key),
  };
};
const root = () => {
  const attributes: Record<string, string> = {};
  return {
    attributes,
    setAttribute: (name: string, value: string) => void (attributes[name] = value),
  };
};

describe('what a person chooses about how Waymark looks', () => {
  it('reads only what it knows, and anything else is the default', () => {
    expect(themeOf('dark')).toBe('dark');
    expect(themeOf('light')).toBe('light');
    for (const value of [null, '', 'system', 'blue']) expect(themeOf(value)).toBe('system');
    expect(readTheme(undefined)).toBe('system');
    expect(
      readTheme({
        getItem: () => {
          throw new Error('blocked');
        },
      }),
    ).toBe('system');
  });

  it('keeps a theme and puts it on the page, and the system’s choice is the absence of one', () => {
    const store = memory();
    const page = root();
    chooseTheme('dark', page, false, store);
    expect(store.data[THEME_KEY]).toBe('dark');
    expect(page.attributes['data-theme']).toBe('dark');
    expect(readTheme(store)).toBe('dark');
    chooseTheme('system', page, true, store);
    expect(store.data[THEME_KEY]).toBeUndefined();
    expect(page.attributes['data-theme']).toBe('dark');
    chooseTheme('system', page, false, store);
    expect(page.attributes['data-theme']).toBe('light');
  });

  it('still applies a choice when storage is blocked', () => {
    const page = root();
    chooseTheme('light', page, true, {
      setItem: () => {
        throw new Error('blocked');
      },
      removeItem: () => undefined,
    });
    expect(page.attributes['data-theme']).toBe('light');
  });
});

describe('the script that sets the theme before first paint', () => {
  /** Runs the script against a page that holds `stored` and whose system scheme is `dark`. */
  function run(stored: string | null, dark: boolean) {
    const attributes: Record<string, string> = {};
    const listeners: (() => void)[] = [];
    const query = {
      matches: dark,
      addEventListener: (_: string, fn: () => void) => listeners.push(fn),
    };
    const window = {
      localStorage: { getItem: (key: string) => (key === THEME_KEY ? stored : null) },
      matchMedia: () => query,
    };
    const document = {
      documentElement: { setAttribute: (n: string, v: string) => void (attributes[n] = v) },
    };
    new Function('window', 'document', themeScript)(window, document);
    return { attributes, query, listeners };
  }

  it('uses the key the page keeps the choice under', () => {
    expect(themeScript).toContain(`'${THEME_KEY}'`);
  });

  it('follows the system when nothing is chosen, and a choice wins over it', () => {
    expect(run(null, true).attributes['data-theme']).toBe('dark');
    expect(run(null, false).attributes['data-theme']).toBe('light');
    expect(run('light', true).attributes['data-theme']).toBe('light');
    expect(run('dark', false).attributes['data-theme']).toBe('dark');
  });

  it('ignores a stored value it does not know', () => {
    expect(run('purple', true).attributes['data-theme']).toBe('dark');
  });

  it('keeps in step when the system changes', () => {
    const { attributes, query, listeners } = run(null, false);
    query.matches = true;
    for (const listener of listeners) listener();
    expect(attributes['data-theme']).toBe('dark');
  });

  it('does not throw when storage or the media query is unavailable', () => {
    const document = { documentElement: { setAttribute: () => undefined } };
    expect(() =>
      new Function('window', 'document', themeScript)(
        {
          localStorage: {
            getItem: () => {
              throw new Error('blocked');
            },
          },
          matchMedia: () => {
            throw new Error('none');
          },
        },
        document,
      ),
    ).not.toThrow();
  });
});
