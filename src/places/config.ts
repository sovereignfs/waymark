import type { Problem } from '../config';
import type { HostRule } from '../security/outbound';

/**
 * Place search (DESIGN.md §7.2): `WAYMARK_PLACES_PROVIDER` is `nominatim` (the default), `photon` or `off`, and `WAYMARK_PLACES_URL` is where it is. With no address the provider
 * is the public instance of its kind, whose usage policy Waymark keeps (`finder.ts`: one request a second from the whole server, results kept a day). **An address of the
 * operator's own lifts all of that**, and may be plain http on a network of its own, which the public one never may. `off` is no place search at all: adding a place by hand
 * still works (DESIGN.md §7.2, step 3), and a screen says why there is nothing to search.
 */
export type PlacesProvider = 'nominatim' | 'photon' | 'off';

export interface PlacesSettings {
  readonly provider: PlacesProvider;
  /** The provider's address with no trailing slash, or undefined for `off`. */
  readonly url: string | undefined;
  /** Whether this is the public instance of the provider, with its usage policy. */
  readonly public: boolean;
  /** What the outbound helper may reach for it, and nothing else. Empty for `off`. */
  readonly allow: readonly HostRule[];
}

export const PUBLIC_URLS = {
  nominatim: 'https://nominatim.openstreetmap.org',
  photon: 'https://photon.komoot.io',
} as const;

export function resolvePlaces(
  read: (name: string) => string | undefined,
  problems: Problem[],
): PlacesSettings {
  const rawProvider = read('WAYMARK_PLACES_PROVIDER');
  const provider = (rawProvider ?? 'nominatim').trim().toLowerCase();
  if (provider !== 'nominatim' && provider !== 'photon' && provider !== 'off') {
    problems.push('WAYMARK_PLACES_PROVIDER is nominatim, photon or off.');
    return { provider: 'off', url: undefined, public: false, allow: [] };
  }
  if (provider === 'off') return { provider, url: undefined, public: false, allow: [] };

  const raw = read('WAYMARK_PLACES_URL');
  const url = (raw ?? PUBLIC_URLS[provider]).trim().replace(/\/+$/, '');
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    problems.push(
      'WAYMARK_PLACES_URL is not an address. Give it as https://nominatim.example.com.',
    );
    return { provider, url: undefined, public: false, allow: [] };
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:')
    problems.push('WAYMARK_PLACES_URL must be an http or https address.');
  else if (parsed.username || parsed.password)
    problems.push('WAYMARK_PLACES_URL must not carry a user name or password.');
  else if (parsed.search || parsed.hash)
    problems.push('WAYMARK_PLACES_URL is an address with no query or fragment.');

  // By its name, whatever the scheme or port: the public host is never treated as the operator's own, so its policy cannot be lifted by how its address is written.
  const isPublic = parsed.hostname.toLowerCase() === new URL(PUBLIC_URLS[provider]).hostname;
  // Plain http, and a private address, are for the operator's own: a Nominatim on the network the app is on.
  const own = !isPublic;
  if (parsed.protocol === 'http:' && isPublic)
    problems.push('The public place search is https only.');
  return {
    provider,
    url,
    public: isPublic,
    allow: [{ host: parsed.hostname.toLowerCase(), allowPrivate: own, allowHttp: own }],
  };
}
