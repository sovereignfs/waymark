# Waymark

Check in where you are, plan trips with the people going and the people following, and look back on everywhere you have been, on a map. It is an app of
the [Sovereign](https://github.com/sovereignfs/sovereign) suite, and it runs fully on its own: its own accounts, mail, notices, files and map, with no
instance needed.

- **Check-ins** stand alone: a place, a moment, a note, photos. They are written on your device first and sync when there is a connection.
- **Trips** are folders of stops, days and plans that check-ins fall into when the dates match, shared with the people going (Organizers and Travelers)
  and the people following.
- **Trip Mode** shows today's plan, the next stop and the way there, and works offline.

Everything that says where you were or what you wrote is encrypted before it is stored. It replaces the legacy plugin
[`sovereign-plugin-travellog`](https://github.com/sovereignfs/sovereign-plugin-travellog); none of its code, data or interface is carried over.

## Status

**Planned, and being built.** [`DESIGN.md`](DESIGN.md) is the design, [`ROADMAP.md`](ROADMAP.md) the order of work and status of every task, and
[`docs/epics/`](docs/epics/) the detail of each. The app has three phases, a release each: check-ins (0.1.0), trips (0.2.0), Trip Mode (0.3.0).
Nothing is released yet.

## Working on it

You need Node 24.15 or newer and [pnpm](https://pnpm.io) (the version is `packageManager` in `package.json`).

```bash
pnpm install --frozen-lockfile
pnpm format:check && pnpm lint && pnpm typecheck && pnpm test
pnpm dev     # http://localhost:3005
```

The conventions, for people and for agents, are in [`AGENTS.md`](AGENTS.md) and [`CONTRIBUTING.md`](CONTRIBUTING.md).

## The map

The map is drawn in the browser from vector tiles that **Waymark serves itself** (`/api/map/*`, for signed-in people): the browser asks no one else for a style, a tile or a letter. `WAYMARK_MAP_SOURCE` says where the tiles come from:

- **`proxy`** (the default): the server fetches each tile once from `WAYMARK_MAP_UPSTREAM_URL` and keeps it under `/data/map/cache`, which `WAYMARK_MAP_CACHE_MAX_MB` (2048) bounds, the tiles read longest ago going first. The default upstream is
  **[OpenFreeMap](https://openfreemap.org)'s planet** (`https://tiles.openfreemap.org/planet`): free, no key, OpenStreetMap data in the OpenMapTiles schema, which is the schema Waymark's style is written for. Its [terms](https://openfreemap.org/tos/) state no
  request limit and no service level, ask that anything fetched in bulk says who it is (Waymark's User-Agent names itself and the instance's address), and **do not say whether a server may fetch tiles for the people using it and keep them**. A tile is
  fetched only when someone looks at that part of the map, and only once, but that is not permission, and the service may change or end without notice: **an operator who relies on the map should use `pmtiles` or a tile server of their own**, and
  anyone running more than a handful of people should ask OpenFreeMap first.
- **`pmtiles`**: tiles are read from the file at `WAYMARK_MAP_PMTILES_PATH`, by range, with no request to anyone, ever. The file holds vector tiles in the **OpenMapTiles schema**, uncompressed or gzip inside: `planetiler --area=portugal --output=portugal.pmtiles`
  makes one for a region, and the planet is the same command for all of it. (A Protomaps basemap build is another schema, which the style does not draw.)
- **`off`**: no map. Every map view shows its list, and every map address answers 404.

An upstream of your own is a TileJSON address or a tile address with `{z}`, `{x}` and `{y}`; it may be http on a private network, which the default never may. The style (a light and a dark one, in the design system's colours) is Waymark's own and
draws with shapes and text, so there are no icons to serve. **Letters** (Noto Sans Regular and Bold, SIL Open Font License 1.1, from OpenFreeMap's build, `src/map/assets/fonts`): Latin, Greek, Cyrillic and punctuation are in the image, 1.2 MB; any other script is
fetched from the default upstream and kept, with `proxy`, and with `pmtiles` its labels show their Latin name. Every map shows its attribution: © OpenStreetMap contributors (the data is ODbL), © OpenMapTiles, and OpenFreeMap for its tiles.

## Licence

[AGPL-3.0-or-later](LICENSE), since it bundles `@sovereignfs/ui`.
