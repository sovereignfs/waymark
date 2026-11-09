/**
 * The Content-Security-Policy every page is sent with, and the headers that go with it (DESIGN.md §25 Security).
 *
 * What people write (places, notes, titles, names) reaches the page, and the page holds a person's whole history: it must stay safe even if a way to
 * put markup in a note were found. Nothing may run that the server did not mark, and nothing third-party may load: the map's style, tiles, glyphs
 * and sprites come from `/api/map` and place search from `/api/places`, so the browser talks only to its own server.
 *
 *  - **Scripts** run only with this request's nonce, or when a script that has it loads them (`'strict-dynamic'`): the bundles Next adds, and the
 *    theme script in the layout. No inline handler, no `javascript:` address, no `eval` (but in development, where React wants it).
 *  - **Style *elements*** carry the nonce too. **Style *attributes* are allowed**: React's `style` props and the design system's overlays position
 *    things with them, and an attribute can change how something looks but cannot run anything.
 *  - **Everything else comes from this origin**: images (and `data:` and `blob:`, for a photo taken offline and not yet sent), fonts (the design
 *    system's own, served from here), `connect-src` (sync and the other APIs), the manifest. **`worker-src` is this origin and `blob:`**: the service
 *    worker, and MapLibre's web worker, which is built from a blob unless the design system serves it as a file (checked in 17.1, and narrowed to
 *    `'self'` if it can be). No frames, no plugins, nobody may frame a page (`frame-ancestors`), forms go only here, `<base>` cannot be changed.
 *  - **`upgrade-insecure-requests`** only where the app is served over https: on `http://localhost` it would send the page's own requests to a port
 *    that does not speak https.
 *
 * The nonce is new for every request and unguessable; a page that uses it cannot be prerendered, which is why every page is rendered per request.
 */
export interface PolicyOptions {
  nonce: string;
  /** The app is served over https (`WAYMARK_URL`). */
  secure: boolean;
  /** `next dev`, which needs `eval`. */
  development: boolean;
}

export function contentSecurityPolicy({ nonce, secure, development }: PolicyOptions): string {
  // `next dev`'s own overlay (the indicator at the bottom left, its menus and error dialog) draws itself with a dozen inline `<style>` elements inside
  // a shadow root, none of which can be given a nonce, so under the production policy it is left unstyled. Development only, and a nonce in the list
  // would make browsers ignore `'unsafe-inline'`, so it stands alone: the production policy below is the one that is tested and shipped.
  const styles = development ? "'self' 'unsafe-inline'" : `'self' 'nonce-${nonce}'`;
  const directives = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${development ? " 'unsafe-eval'" : ''}`,
    `style-src ${styles}`,
    `style-src-elem ${styles}`,
    "style-src-attr 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    "connect-src 'self'",
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    ...(secure ? ['upgrade-insecure-requests'] : []),
  ];
  return directives.join('; ');
}

/** An unguessable value for one request: 128 bits from the platform's random source. */
export function newNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes));
}

/** Headers for every response, pages and APIs alike. `Strict-Transport-Security` is sent only over https, by the proxy. */
export const SECURITY_HEADERS: { key: string; value: string }[] = [
  // A response is what its `Content-Type` says it is: an uploaded file or a note cannot be sniffed into a script.
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  // Old browsers do not know `frame-ancestors`.
  { key: 'X-Frame-Options', value: 'DENY' },
  // A link followed from a page does not tell the other site where it came from.
  { key: 'Referrer-Policy', value: 'no-referrer' },
  {
    key: 'Permissions-Policy',
    // The one thing the app asks of the device is where it is, to check in here (DESIGN.md §9.2): this origin may, nobody it embeds may (it embeds
    // nothing). A photo is taken through a file input, which needs no camera permission.
    value: 'camera=(), microphone=(), geolocation=(self), payment=(), usb=(), interest-cohort=()',
  },
  // Another site's window cannot hold a reference to this one's after a link is followed.
  { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
];

/** A year, and the subdomains: the app is served over https or not at all. */
export const HSTS = 'max-age=31536000; includeSubDomains';
