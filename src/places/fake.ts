import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

/**
 * A place search that is a few lines of code, for the tests and for `pnpm dev` (DESIGN.md §7.2, §25 Testing): it answers as Nominatim does at `/search` and `/reverse`, and as Photon
 * does at `/api/` and `/reverse`, from a short list of real places, and **reaches nothing**. `pnpm places:fake` starts it on a port and `WAYMARK_PLACES_URL=http://localhost:<port>` points
 * the app at it; the tests start one of their own and count what it was asked. Self-contained, so that a script can run it without the app's build.
 */
export interface FakePlace {
  readonly osm: 'node' | 'way' | 'relation';
  readonly id: number;
  readonly name: string;
  readonly lat: number;
  readonly lng: number;
  readonly type: string;
  readonly road?: string;
  readonly houseNumber?: string;
  readonly city: string;
  readonly region?: string;
  readonly country: string;
  readonly countryCode: string;
  readonly postcode?: string;
}

export const FAKE_PLACES: readonly FakePlace[] = [
  {
    osm: 'way',
    id: 100001,
    name: 'Tokyo Tower',
    lat: 35.6586,
    lng: 139.7454,
    type: 'tower',
    road: 'Shibakoen',
    city: 'Minato',
    region: 'Tokyo',
    country: 'Japan',
    countryCode: 'jp',
    postcode: '105-0011',
  },
  {
    osm: 'node',
    id: 100002,
    name: 'Café de Flore',
    lat: 48.854,
    lng: 2.3326,
    type: 'cafe',
    road: 'Boulevard Saint-Germain',
    houseNumber: '172',
    city: 'Paris',
    region: 'Île-de-France',
    country: 'France',
    countryCode: 'fr',
    postcode: '75006',
  },
  {
    osm: 'node',
    id: 100003,
    name: 'Café Central',
    lat: 48.2104,
    lng: 16.3655,
    type: 'cafe',
    road: 'Herrengasse',
    houseNumber: '14',
    city: 'Vienna',
    country: 'Austria',
    countryCode: 'at',
    postcode: '1010',
  },
  {
    osm: 'relation',
    id: 100004,
    name: 'Sé de Lisboa',
    lat: 38.7097,
    lng: -9.1329,
    type: 'place_of_worship',
    road: 'Largo da Sé',
    city: 'Lisbon',
    country: 'Portugal',
    countryCode: 'pt',
    postcode: '1100-585',
  },
  {
    osm: 'node',
    id: 100005,
    name: 'Central Park',
    lat: 40.7829,
    lng: -73.9654,
    type: 'park',
    city: 'New York',
    region: 'New York',
    country: 'United States',
    countryCode: 'us',
  },
  {
    osm: 'node',
    id: 100006,
    name: 'Kiritimati Airport',
    lat: 1.9861,
    lng: -157.4503,
    type: 'aerodrome',
    city: 'Kiritimati',
    country: 'Kiribati',
    countryCode: 'ki',
  },
];

const OSM_LETTER = { node: 'N', way: 'W', relation: 'R' } as const;

const norm = (text: string) =>
  text
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase();

function matches(place: FakePlace, query: string): boolean {
  const words = norm(query).split(/\s+/).filter(Boolean);
  const text = norm(`${place.name} ${place.city} ${place.country} ${place.type}`);
  return words.length > 0 && words.every((word) => text.includes(word));
}

const metres = (a: { lat: number; lng: number }, b: { lat: number; lng: number }) =>
  Math.hypot(
    (a.lat - b.lat) * 111_195,
    (a.lng - b.lng) * 111_195 * Math.cos((a.lat * Math.PI) / 180),
  );

function nominatim(place: FakePlace) {
  return {
    place_id: place.id,
    osm_type: place.osm,
    osm_id: place.id,
    lat: String(place.lat),
    lon: String(place.lng),
    category: 'amenity',
    type: place.type,
    name: place.name,
    display_name: `${place.name}, ${place.city}, ${place.country}`,
    address: {
      ...(place.road ? { road: place.road } : {}),
      ...(place.houseNumber ? { house_number: place.houseNumber } : {}),
      city: place.city,
      ...(place.region ? { state: place.region } : {}),
      country: place.country,
      country_code: place.countryCode,
      ...(place.postcode ? { postcode: place.postcode } : {}),
    },
  };
}

function photon(place: FakePlace) {
  return {
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [place.lng, place.lat] },
    properties: {
      osm_type: OSM_LETTER[place.osm],
      osm_id: place.id,
      osm_key: 'amenity',
      osm_value: place.type,
      name: place.name,
      ...(place.road ? { street: place.road } : {}),
      ...(place.houseNumber ? { housenumber: place.houseNumber } : {}),
      city: place.city,
      ...(place.region ? { state: place.region } : {}),
      country: place.country,
      countrycode: place.countryCode.toUpperCase(),
      ...(place.postcode ? { postcode: place.postcode } : {}),
    },
  };
}

export interface FakeSearch {
  readonly server: Server;
  /** Every path-and-query the fake was asked for, in order, with when. */
  readonly requests: { path: string; at: number; userAgent: string | undefined }[];
  /** Answer with this status (and an error page) from now on, or `undefined` to answer as usual again. */
  failWith(status: number | undefined): void;
  /** Wait this long before answering, to keep a request in flight. */
  delay(ms: number): void;
  url(): string;
  close(): Promise<void>;
}

/** Starts the fake on `port` (0 for any) of the loopback address. */
export async function startFakePlaces(port = 0): Promise<FakeSearch> {
  let failing: number | undefined;
  let waitMs = 0;
  const requests: FakeSearch['requests'] = [];
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url ?? '/', 'http://fake');
    requests.push({
      path: `${url.pathname}${url.search}`,
      at: Date.now(),
      userAgent: request.headers['user-agent'],
    });
    const reply = () => {
      if (failing !== undefined) {
        response.writeHead(failing, { 'content-type': 'text/html' });
        return response.end('<html>nothing here</html>');
      }
      const json = (body: unknown) => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify(body));
      };
      const q = url.searchParams.get('q') ?? '';
      const lat = Number(url.searchParams.get('lat'));
      const lng = Number(url.searchParams.get('lon'));
      if (url.pathname === '/search')
        return json(FAKE_PLACES.filter((p) => matches(p, q)).map(nominatim));
      if (url.pathname === '/api/' || url.pathname === '/api')
        return json({
          type: 'FeatureCollection',
          features: FAKE_PLACES.filter((p) => matches(p, q)).map(photon),
        });
      if (url.pathname === '/reverse') {
        const nearest = [...FAKE_PLACES].sort(
          (a, b) => metres(a, { lat, lng }) - metres(b, { lat, lng }),
        )[0];
        const near = nearest && metres(nearest, { lat, lng }) < 500 ? nearest : undefined;
        // Nominatim answers an object (or an error object); Photon, a collection. The one path serves whichever was asked for by its shape.
        return json(
          url.searchParams.has('format')
            ? near
              ? nominatim(near)
              : { error: 'Unable to geocode' }
            : { type: 'FeatureCollection', features: near ? [photon(near)] : [] },
        );
      }
      response.writeHead(404);
      response.end();
    };
    if (waitMs > 0) setTimeout(reply, waitMs);
    else reply();
  });
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  return {
    server,
    requests,
    failWith: (status) => {
      failing = status;
    },
    delay: (ms) => {
      waitMs = ms;
    },
    url: () => `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
