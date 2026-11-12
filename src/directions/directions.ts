/**
 * **Directions** (DESIGN.md §14.3): a hand-off to the device's own maps, with the item's point and name, and nothing fetched by Waymark. One convention, decided by the device and documented in the README:
 *
 *  - **Android:** `geo:<lat>,<lng>?q=<lat>,<lng>(<name>)`, which any maps app that handles `geo:` opens;
 *  - **iPhone and iPad:** `maps://?daddr=<lat>,<lng>&q=<name>` (Apple Maps), including an iPad that says it is a Mac but has a touch screen;
 *  - **anywhere else:** an OpenStreetMap directions link, `https://www.openstreetmap.org/directions?route=;<lat>,<lng>`, which opens in a browser.
 *
 * Pure: the device is given in (`userAgent`, `platform`, `maxTouchPoints`), so that what is decided is tested without a browser. A name is one line of at most 100 characters with no control characters, percent-encoded, so that a
 * place's name cannot add a parameter or a scheme to the link. A point that is not a point is no link.
 */
export type MapsPlatform = 'android' | 'apple' | 'other';

export interface DeviceHints {
  readonly userAgent?: string | undefined;
  readonly platform?: string | undefined;
  readonly maxTouchPoints?: number | undefined;
}

export function platformOf(device: DeviceHints): MapsPlatform {
  const agent = device.userAgent ?? '';
  if (/\bAndroid\b/i.test(agent)) return 'android';
  if (/\b(iPhone|iPad|iPod)\b/.test(agent)) return 'apple';
  // An iPad asks for the desktop site and says it is a Mac; only a touch screen tells them apart.
  if ((device.platform ?? '') === 'MacIntel' && (device.maxTouchPoints ?? 0) > 1) return 'apple';
  return 'other';
}

export interface Destination {
  readonly lat: number;
  readonly lng: number;
  readonly name?: string | undefined;
}

const valid = (lat: unknown, lng: unknown): lat is number =>
  typeof lat === 'number' &&
  typeof lng === 'number' &&
  Number.isFinite(lat) &&
  Number.isFinite(lng) &&
  Math.abs(lat) <= 90 &&
  Math.abs(lng) <= 180;

/** A name for the link: one line, trimmed, at most 100 characters, with control characters and the characters a `geo:` label cannot hold taken out. */
export function nameFor(name: string | undefined): string {
  return Array.from(name ?? '')
    .filter((char) => {
      const code = char.codePointAt(0) ?? 0;
      return code > 0x1f && !(code >= 0x7f && code <= 0x9f) && char !== '(' && char !== ')';
    })
    .join('')
    .trim()
    .slice(0, 100)
    .trim();
}

/** Five decimal places is a metre or so, and a link is no place for more. */
const coordinate = (n: number) => String(Math.round(n * 1e5) / 1e5);

/** The link to open for this device, or undefined for a point that is not one. */
export function directionsLink(platform: MapsPlatform, to: Destination): string | undefined {
  if (!valid(to.lat, to.lng)) return undefined;
  const point = `${coordinate(to.lat)},${coordinate(to.lng)}`;
  const name = nameFor(to.name);
  if (platform === 'android')
    return `geo:${point}?q=${point}${name ? `(${encodeURIComponent(name)})` : ''}`;
  if (platform === 'apple')
    return `maps://?daddr=${point}${name ? `&q=${encodeURIComponent(name)}` : ''}`;
  return `https://www.openstreetmap.org/directions?route=${encodeURIComponent(`;${point}`)}`;
}
