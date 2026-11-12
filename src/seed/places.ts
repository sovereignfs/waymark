import type { PlaceSource } from '../places/clean';

/**
 * The places the development seed checks in at (task 16.1): real cities, invented names, so nothing here is anyone's. A *base* is where the seeded person lives for a stretch, with the places a week is
 * made of, **the first of which is the one visited most**; a *destination* is a trip away. The order inside a list is the weight, heaviest first.
 */
export interface SeedPlace {
  readonly key: string;
  readonly name: string;
  readonly lat: number;
  readonly lng: number;
  readonly category: string;
  readonly address: {
    readonly street?: string;
    readonly city: string;
    readonly country: string;
    readonly countryCode: string;
  };
  readonly source: PlaceSource;
}

export interface SeedCity {
  readonly name: string;
  readonly tz: string;
  readonly places: readonly SeedPlace[];
}

const place = (
  city: string,
  country: string,
  countryCode: string,
  key: string,
  name: string,
  category: string,
  lat: number,
  lng: number,
  street?: string,
  source: PlaceSource = 'osm',
): SeedPlace => ({
  key,
  name,
  lat,
  lng,
  category,
  address: { ...(street ? { street } : {}), city, country, countryCode },
  source,
});

/** A place of the person's own city: made by hand, as a person adds the places of their week. */
const home =
  (city: string, country: string, code: string) =>
  (
    key: string,
    name: string,
    category: string,
    lat: number,
    lng: number,
    street?: string,
  ): SeedPlace =>
    place(city, country, code, key, name, category, lat, lng, street, 'manual');
const lisbon = home('Lisbon', 'Portugal', 'PT');
const berlin = home('Berlin', 'Germany', 'DE');

/** Where the seeded person lives before, and since, `MOVED_ON`. */
export const BERLIN: SeedCity = {
  name: 'Berlin',
  tz: 'Europe/Berlin',
  places: [
    berlin('berlin-cafe', 'Café Morgenrot', 'Café', 52.4994, 13.4204, 'Kottbusser Damm 12'),
    berlin(
      'berlin-studio',
      'Studio Spree',
      'Coworking space',
      52.5014,
      13.4453,
      'Stralauer Allee 3',
    ),
    berlin(
      'berlin-pool',
      'Stadtbad Neukölln',
      'Swimming pool',
      52.4811,
      13.4343,
      'Ganghoferstraße 3',
    ),
    berlin('berlin-market', 'Markthalle Neun', 'Market', 52.5019, 13.4314, 'Eisenbahnstraße 42'),
    berlin('berlin-park', 'Tempelhofer Feld', 'Park', 52.4733, 13.4033),
    berlin('berlin-books', 'Bücherbogen', 'Bookshop', 52.5062, 13.3228, 'Savignyplatz 5'),
    berlin('berlin-bar', 'Bar am Wasser', 'Bar', 52.4999, 13.4421, 'Paul-Lincke-Ufer 21'),
  ],
};

export const LISBON: SeedCity = {
  name: 'Lisbon',
  tz: 'Europe/Lisbon',
  places: [
    lisbon('lisbon-cafe', 'Café da Beira', 'Café', 38.7128, -9.1594, 'Rua da Beira 18'),
    lisbon(
      'lisbon-coworking',
      'Casa do Largo',
      'Coworking space',
      38.7081,
      -9.1365,
      'Largo do Carmo 4',
    ),
    lisbon('lisbon-gym', 'Ginásio Alfama', 'Gym', 38.7116, -9.1286, 'Rua de São Tomé 9'),
    lisbon('lisbon-park', 'Jardim da Estrela', 'Park', 38.7139, -9.1597),
    lisbon(
      'lisbon-market',
      'Mercado de Campo de Ourique',
      'Market',
      38.7168,
      -9.1672,
      'Rua Coelho da Rocha 104',
    ),
    lisbon(
      'lisbon-books',
      'Livraria Descobertas',
      'Bookshop',
      38.7106,
      -9.1423,
      'Rua Nova da Trindade 12',
    ),
    lisbon('lisbon-viewpoint', 'Miradouro da Graça', 'Viewpoint', 38.7184, -9.1304),
    lisbon('lisbon-bar', 'Taberna do Beco', 'Bar', 38.7102, -9.1389, 'Beco do Carneiro 3'),
  ],
};

const there =
  (city: string, country: string, code: string) =>
  (
    key: string,
    name: string,
    category: string,
    lat: number,
    lng: number,
    street?: string,
  ): SeedPlace =>
    place(city, country, code, key, name, category, lat, lng, street);

const tokyo = there('Tokyo', 'Japan', 'JP');
const kyoto = there('Kyoto', 'Japan', 'JP');
const newYork = there('New York', 'United States', 'US');
const mexicoCity = there('Mexico City', 'Mexico', 'MX');
const capeTown = there('Cape Town', 'South Africa', 'ZA');
const reykjavik = there('Reykjavík', 'Iceland', 'IS');
const istanbul = there('Istanbul', 'Türkiye', 'TR');
const sydney = there('Sydney', 'Australia', 'AU');
const buenosAires = there('Buenos Aires', 'Argentina', 'AR');
const marrakesh = there('Marrakesh', 'Morocco', 'MA');
const vancouver = there('Vancouver', 'Canada', 'CA');
const singapore = there('Singapore', 'Singapore', 'SG');
const rome = there('Rome', 'Italy', 'IT');
const nairobi = there('Nairobi', 'Kenya', 'KE');

/** Places to go to, each a different time zone from the bases (and from each other) where the world allows. */
export const DESTINATIONS: readonly SeedCity[] = [
  {
    name: 'Tokyo',
    tz: 'Asia/Tokyo',
    places: [
      tokyo(
        'tokyo-ramen',
        'Ichiban Ramen Yokocho',
        'Restaurant',
        35.6938,
        139.7034,
        'Shinjuku 1-1',
      ),
      tokyo('tokyo-temple', 'Sensō-ji', 'Temple', 35.7148, 139.7967),
      tokyo('tokyo-crossing', 'Shibuya Crossing', 'Landmark', 35.6595, 139.7005),
      tokyo('tokyo-garden', 'Shinjuku Gyoen', 'Park', 35.6852, 139.71),
      tokyo('tokyo-kissa', 'Kissa Yume', 'Café', 35.7003, 139.7731, 'Kanda 3-2'),
      tokyo('tokyo-market', 'Tsukiji Outer Market', 'Market', 35.6655, 139.7707),
    ],
  },
  {
    name: 'Kyoto',
    tz: 'Asia/Tokyo',
    places: [
      kyoto('kyoto-shrine', 'Fushimi Inari Taisha', 'Shrine', 34.9671, 135.7727),
      kyoto('kyoto-bamboo', 'Arashiyama Bamboo Grove', 'Park', 35.0094, 135.6722),
      kyoto('kyoto-tea', 'Gion Tea House', 'Café', 35.0037, 135.7756, 'Gion 4'),
      kyoto('kyoto-market', 'Nishiki Market', 'Market', 35.005, 135.7649),
    ],
  },
  {
    name: 'New York',
    tz: 'America/New_York',
    places: [
      newYork('nyc-diner', 'Corner Diner', 'Restaurant', 40.7411, -73.9897, '23rd Street'),
      newYork('nyc-park', 'Central Park Reservoir', 'Park', 40.7851, -73.9583),
      newYork('nyc-museum', 'Museum of Modern Things', 'Museum', 40.7614, -73.9776, '53rd Street'),
      newYork('nyc-highline', 'The High Line', 'Park', 40.748, -74.0048),
      newYork('nyc-books', 'Strand Annex', 'Bookshop', 40.7332, -73.9908, 'Broadway'),
    ],
  },
  {
    name: 'Mexico City',
    tz: 'America/Mexico_City',
    places: [
      mexicoCity(
        'cdmx-tacos',
        'Taquería El Faro',
        'Restaurant',
        19.4326,
        -99.1332,
        'Calle Madero 4',
      ),
      mexicoCity('cdmx-zocalo', 'Zócalo', 'Plaza', 19.4326, -99.1332),
      mexicoCity('cdmx-frida', 'Casa Azul', 'Museum', 19.3551, -99.1626),
      mexicoCity('cdmx-chapultepec', 'Bosque de Chapultepec', 'Park', 19.4204, -99.1819),
    ],
  },
  {
    name: 'Cape Town',
    tz: 'Africa/Johannesburg',
    places: [
      capeTown('ct-mountain', 'Table Mountain Cableway', 'Landmark', -33.9488, 18.4035),
      capeTown('ct-waterfront', 'Harbour Market', 'Market', -33.9017, 18.4219, 'Dock Road'),
      capeTown('ct-beach', 'Clifton Fourth Beach', 'Beach', -33.9395, 18.3764),
      capeTown('ct-wine', 'Constantia Wine Estate', 'Winery', -34.0286, 18.4237),
    ],
  },
  {
    name: 'Reykjavík',
    tz: 'Atlantic/Reykjavik',
    places: [
      reykjavik('rvk-church', 'Hallgrímskirkja', 'Church', 64.1417, -21.9266),
      reykjavik('rvk-pool', 'Sundhöllin', 'Swimming pool', 64.1437, -21.9262, 'Barónsstígur'),
      reykjavik('rvk-hotdog', 'Bæjarins Beztu', 'Restaurant', 64.1484, -21.9411),
    ],
  },
  {
    name: 'Istanbul',
    tz: 'Europe/Istanbul',
    places: [
      istanbul('ist-bazaar', 'Grand Bazaar', 'Market', 41.0107, 28.968),
      istanbul('ist-ferry', 'Karaköy Ferry Pier', 'Ferry', 41.0227, 28.9772),
      istanbul('ist-tea', 'Çay Bahçesi Galata', 'Café', 41.0256, 28.9744, 'Galata'),
      istanbul('ist-mosque', 'Süleymaniye Mosque', 'Mosque', 41.0162, 28.964),
    ],
  },
  {
    name: 'Sydney',
    tz: 'Australia/Sydney',
    places: [
      sydney('syd-opera', 'Harbour Opera House', 'Landmark', -33.8568, 151.2153),
      sydney('syd-bondi', 'Bondi Beach', 'Beach', -33.8915, 151.2767),
      sydney('syd-coffee', 'Flat White Lane', 'Café', -33.8731, 151.2065, 'Kent Street'),
      sydney('syd-ferry', 'Manly Ferry Wharf', 'Ferry', -33.8615, 151.2115),
    ],
  },
  {
    name: 'Buenos Aires',
    tz: 'America/Argentina/Buenos_Aires',
    places: [
      buenosAires(
        'ba-milonga',
        'La Catedral Milonga',
        'Dance hall',
        -34.6037,
        -58.4219,
        'Sarmiento 4006',
      ),
      buenosAires('ba-cemetery', 'La Recoleta', 'Cemetery', -34.5875, -58.3935),
      buenosAires(
        'ba-parrilla',
        'Parrilla Don Julio',
        'Restaurant',
        -34.5882,
        -58.4258,
        'Guatemala 4691',
      ),
    ],
  },
  {
    name: 'Marrakesh',
    tz: 'Africa/Casablanca',
    places: [
      marrakesh('mrk-souk', 'Souk Semmarine', 'Market', 31.6295, -7.9811),
      marrakesh('mrk-square', 'Jemaa el-Fnaa', 'Plaza', 31.6258, -7.9891),
      marrakesh('mrk-garden', 'Jardin Majorelle', 'Garden', 31.6417, -8.0033),
    ],
  },
  {
    name: 'Vancouver',
    tz: 'America/Vancouver',
    places: [
      vancouver('van-seawall', 'Stanley Park Seawall', 'Park', 49.3043, -123.1443),
      vancouver('van-granville', 'Granville Island', 'Market', 49.2712, -123.134),
      vancouver('van-coffee', 'Gastown Roasters', 'Café', 49.2836, -123.1087, 'Water Street'),
    ],
  },
  {
    name: 'Singapore',
    tz: 'Asia/Singapore',
    places: [
      singapore('sin-hawker', 'Lau Pa Sat', 'Hawker centre', 1.2806, 103.8504),
      singapore('sin-gardens', 'Gardens by the Bay', 'Park', 1.2816, 103.8636),
      singapore('sin-ferry', 'Marina South Pier', 'Ferry', 1.2704, 103.8636),
    ],
  },
  {
    name: 'Rome',
    tz: 'Europe/Rome',
    places: [
      rome('rome-forum', 'Roman Forum', 'Landmark', 41.8925, 12.4853),
      rome(
        'rome-trattoria',
        'Trattoria da Enzo',
        'Restaurant',
        41.8888,
        12.4704,
        'Via dei Vascellari 29',
      ),
      rome('rome-fountain', 'Fontana di Trevi', 'Landmark', 41.9009, 12.4833),
      rome('rome-gelato', 'Gelateria Fiordiluna', 'Ice cream', 41.8899, 12.4694),
    ],
  },
  {
    name: 'Nairobi',
    tz: 'Africa/Nairobi',
    places: [
      nairobi('nbo-park', 'Nairobi National Park', 'Park', -1.3733, 36.8583),
      nairobi('nbo-sheldrick', 'Elephant Nursery', 'Sanctuary', -1.3736, 36.7956),
      nairobi('nbo-cafe', 'Karura Forest Café', 'Café', -1.2412, 36.8366),
    ],
  },
];
