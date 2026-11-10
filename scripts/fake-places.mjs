// The fake place search, for `pnpm dev` (DESIGN.md §7.2): a few real places, answered as Nominatim answers, and nothing reached.
//
//   pnpm places:fake            # listens on http://127.0.0.1:3990
//
// Then set WAYMARK_PLACES_URL=http://127.0.0.1:3990 in .env and restart `pnpm dev`. Search for "tokyo", "cafe", "lisbon", "central".
import { startFakePlaces } from '../src/places/fake.ts';

const port = Number(process.env.PORT ?? 3990);
const fake = await startFakePlaces(port);
console.log(`The fake place search is at ${fake.url()} (Nominatim's shape; Photon's at /api/).`);
process.on('SIGINT', () => fake.close().then(() => process.exit(0)));
process.on('SIGTERM', () => fake.close().then(() => process.exit(0)));
