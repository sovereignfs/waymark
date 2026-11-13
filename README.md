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

**Phase 1, check-ins (0.1.0), is being finished.** Built: sign-in on its own or through a Sovereign core, check-ins that work offline and sync, places, the Check-ins and Places screens, photos, the map's
server, notices (the bell, mail, and a core's bell), export and import of your own data, rotating the encryption key, and the deployment setups. Waiting on `@sovereignfs/ui` (the map, the photo viewer and the phone's
button, built in `sovereign`) are the Map, Home and phone screens; importing from Swarm waits on a real export. [`DESIGN.md`](DESIGN.md) is the design, [`ROADMAP.md`](ROADMAP.md) the order of work and the status of
every task, and [`docs/epics/`](docs/epics/) the detail of each. The app has three phases, a release each: check-ins (0.1.0), trips (0.2.0), Trip Mode (0.3.0). **Nothing is released yet**;
[`RELEASING.md`](RELEASING.md) says how a release is made.

## Running it on its own

You need Docker, a domain with TLS in front of it, and three values: the address people use, a secret to sign sessions, and the key that seals what people write. This is the smallest setup, one container with a SQLite
file (the image is `ghcr.io/sovereignfs/waymark`, published with the first release):

```bash
docker run -d -p 127.0.0.1:3005:3005 -v waymark:/data \
  -e WAYMARK_DB_DIALECT=sqlite -e WAYMARK_SQLITE_URL=file:/data/waymark.db \
  -e WAYMARK_URL=https://waymark.example.com -e WAYMARK_AUTH_LOCAL=1 \
  -e WAYMARK_AUTH_SECRET="$(openssl rand -base64 48)" -e WAYMARK_ENCRYPTION_KEY="$(openssl rand -base64 32)" \
  ghcr.io/sovereignfs/waymark
```

**Keep the two generated values**: they are written nowhere else. Put a reverse proxy with TLS in front of port 3005, open the address, and **make the first account on the sign-up page** (after it, sign-up is only for people with an invitation to a trip, unless
you set `WAYMARK_AUTH_SIGNUP=closed` or `open`). [`deploy/`](deploy/README.md) has three Compose setups, one for each form of the database, and says how each is started, updated and checked:

| Database               | Setup                                           | For                                                                      |
| ---------------------- | ----------------------------------------------- | ------------------------------------------------------------------------ |
| **sqld** (the default) | `deploy/compose.yaml`                           | Most installs: libSQL's server on a volume of its own                    |
| **A SQLite file**      | `deploy/compose.file.yaml`                      | The smallest: one container. On a local disk, never a network filesystem |
| **PostgreSQL**         | `deploy/compose.yaml` + `compose.postgres.yaml` | An operator who prefers it, or has one                                   |

Whatever the database, **`/data`** holds everything else: the photos and files people add, imports and exports in progress, and the map's cache. It is a volume in every setup. The server checks its settings when it
starts, stops naming every wrong one (never its value), makes and migrates its database, and answers `GET /api/health` when it is ready.

## Hosting it on a Sovereign instance

`./sv app add waymark --image ghcr.io/sovereignfs/waymark:<version>` in the instance's repository hosts it from `sovereign.manifest.json`, which is also the image's label: the instance gives it a database and `/data`, tells it
its address and its core, and makes its two keys once. Grant the app's three scopes (they are in the manifest), set the map source and the mail in `suite.yml`, then `./sv push && ./sv deploy`. People sign in through the
instance and nobody has a password here (`WAYMARK_AUTH_LOCAL` is unset); the instance's bell and email carry Waymark's notices, and a core that cannot do that changes nothing else.
[`deploy/README.md`](deploy/README.md) § On a Sovereign instance has the rest.

## Every setting

Every setting is named `WAYMARK_…`, is read once when the server starts, and is in [`.env.example`](.env.example) with what it does. A secret may be given as `NAME_FILE=/path`, so that it is never in the process list.

| Group                 | Settings                                                                                                                                                                                                                                | Needed                                                                                                                |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| **The address**       | `WAYMARK_URL`                                                                                                                                                                                                                           | Yes, with either way of signing in. https, except on localhost                                                        |
| **Signing in**        | `WAYMARK_AUTH_LOCAL`, `WAYMARK_AUTH_SECRET`, `WAYMARK_AUTH_SIGNUP`, `WAYMARK_AUTH_PASSWORD_MIN_LENGTH`                                                                                                                                  | At least one way in. The secret is 32 characters or more                                                              |
| **Sovereign sign-in** | `WAYMARK_CORE_URL`, `WAYMARK_CORE_CLIENT_ID`, `WAYMARK_CORE_CLIENT_SECRET`                                                                                                                                                              | All three or none. A hosting instance sets them                                                                       |
| **The database**      | `WAYMARK_DB_DIALECT` (`sqld`, `sqlite`, `postgres`), `WAYMARK_SQLD_URL`, `WAYMARK_SQLD_ADMIN_URL`, `WAYMARK_SQLITE_URL`, `WAYMARK_POSTGRES_URL`, `WAYMARK_POSTGRES_POOL_MAX`, `WAYMARK_DB_CONNECT_TIMEOUT_MS`, `WAYMARK_MIGRATIONS_DIR` | The address of the one chosen                                                                                         |
| **Encryption**        | `WAYMARK_ENCRYPTION_KEY`, `WAYMARK_ENCRYPTION_KEY_PREVIOUS`                                                                                                                                                                             | The key, always. The old one only while rotating                                                                      |
| **Files**             | `WAYMARK_DATA_DIR`, `WAYMARK_MEDIA_MAX_ACCOUNT_MB`                                                                                                                                                                                      | No: `/data`, 500 MB an account                                                                                        |
| **The map**           | `WAYMARK_MAP_SOURCE`, `WAYMARK_MAP_UPSTREAM_URL`, `WAYMARK_MAP_CACHE_MAX_MB`, `WAYMARK_MAP_PMTILES_PATH`                                                                                                                                | No: `proxy` to OpenFreeMap. See "The map" below                                                                       |
| **Finding a place**   | `WAYMARK_PLACES_PROVIDER` (`nominatim`, `photon`, `off`), `WAYMARK_PLACES_URL`                                                                                                                                                          | No. See "What leaves the server"                                                                                      |
| **Mail**              | `WAYMARK_SMTP_HOST`, `WAYMARK_SMTP_PORT`, `WAYMARK_SMTP_FROM`, `WAYMARK_SMTP_USER`, `WAYMARK_SMTP_PASSWORD[_FILE]`                                                                                                                      | No. With no host there is no mail: addresses are not verified, passwords not reset by mail                            |
| **Web Push**          | `WAYMARK_VAPID_PRIVATE_KEY` (a random secret of 32 characters or more; the key push services want is derived from it)                                                                                                                   | No. With no secret, no device is offered push; with one, `WAYMARK_URL` is the address a push service can reach you at |
| **Limits of trips**   | `WAYMARK_LIMIT_TRIP_MEMBERS`, `WAYMARK_LIMIT_TRIP_STOPS`, `WAYMARK_LIMIT_DAY_ITEMS`, `WAYMARK_LIMIT_TRIP_ATTACHMENTS`, `WAYMARK_LIMIT_ACCOUNT_TRIPS`                                                                                    | No: 30, 50, 200, 100 and 300. Lowering one never deletes anything                                                     |
| **Jobs**              | `WAYMARK_WORKER` (`off` on all but one process that shares a database)                                                                                                                                                                  | No                                                                                                                    |

## What leaves the server

The browser talks only to Waymark's own server: no third-party script, font, tile or image is ever loaded by a page. The **server** makes requests only to hosts you configure, through one helper that refuses a private
address (unless the setting is yours), a redirect elsewhere, and an answer that is too big:

- **Place search** sends **what a person types in the search box** to the provider you chose, from the server, never the browser, with a User-Agent that names Waymark and your address. The default is the public Nominatim
  instance, whose usage policy Waymark keeps (one request a second for the whole server, results kept a day); `WAYMARK_PLACES_URL` points at an instance of your own, which lifts all of that, and `off` sends nothing: a
  place can still be added by hand.
- **The map's tiles** are fetched by the server from `WAYMARK_MAP_UPSTREAM_URL` (OpenFreeMap by default), one tile when someone looks at that part of the map, so the provider learns which parts of the world your people look
  at, and not who they are. `pmtiles` reads a file and asks no one (see "The map").
- **Importing from Swarm** (when it is built) reads photos from Foursquare's own hosts and from nowhere else.
- **Mail** goes to the SMTP server you name; **a Sovereign core** receives notices, and only if you signed in through one.
- **Web Push** goes to a person's own browser's push service (Google's, Mozilla's, Apple's or Microsoft's: whichever their browser uses, and no other host), encrypted to their device, and says only what kind of notice it is and where it opens in the app, never a place, a note or a name. It costs nothing. On iPhone and iPad it works once Waymark is added to the Home Screen; Settings says so. Changing `WAYMARK_VAPID_PRIVATE_KEY` makes every subscription useless, and people turn push on again.

Nothing is sent to Waymark's authors, and there is no analytics.

## What encryption at rest does, and does not, protect

Everything that says where or what (place names, points, addresses, notes, titles, companions, people's names and addresses, and every photo and file) is **sealed**, one envelope for each row and each file, under
`WAYMARK_ENCRYPTION_KEY`, before it is stored; what is not sealed is ids, times and which rows belong to whom. **It protects** a copied database file, a stolen disk, and a backup that falls into the wrong hands. **It does not
protect** against anyone who can run the server or read its environment, since the server has the key and must read the data to show it; nor against a person who is signed in as someone else. **Lose the key and the data
cannot be read, and nothing can recover it**: keep it with your secrets and apart from your backups. Search, distance and figures are worked out in memory on rows the server has opened, which is why a place's name is never in
a database query. To change the key without losing anything, see "Rotating the encryption key".

## Backups

Back up **the database and `/data` together**, and the key separately: a database without `/data` loses the photos, and either without the key cannot be read. `deploy/README.md` says how for each form of the database
(a snapshot of the sqld volume, `sqlite3 … ".backup"` or Litestream for a file, `pg_dump` for PostgreSQL). Each person can also **export their own data** from Settings, which is neither a substitute for this nor the
reverse. Before a minor release, take a backup: migrations only go forward, and going back means restoring it.

## Using it

[`docs/user-guide.md`](docs/user-guide.md) is a short guide for the people who use it: checking in, working offline, and bringing your places in.

## Working on it

You need Node 24.15 or newer and [pnpm](https://pnpm.io) (the version is `packageManager` in `package.json`).

```bash
pnpm install --frozen-lockfile
pnpm format:check && pnpm lint && pnpm typecheck && pnpm test
pnpm dev     # http://localhost:3005
pnpm seed    # three accounts and years of check-ins with photos, in a development database
```

`pnpm seed` refuses any database that is not plainly on your machine (`src/seed/guard.ts`), so it cannot reach a real instance; it makes nothing twice if you run it again.

The conventions, for people and for agents, are in [`AGENTS.md`](AGENTS.md) and [`CONTRIBUTING.md`](CONTRIBUTING.md).

## Rotating the encryption key

Everything that says where or what (places, notes, names, files, photos) is sealed under `WAYMARK_ENCRYPTION_KEY`. To change that key without losing anything:

1. Make a new key (32 random bytes, as base64 or hex), and keep the old one.
2. Set `WAYMARK_ENCRYPTION_KEY` to the **new** key and `WAYMARK_ENCRYPTION_KEY_PREVIOUS` to the **old** one, and restart. Everything still opens: Waymark can read what is under either.
3. A background job moves every row and file from the old key to the new, from where it left off if it is stopped or the server is restarted. It only re-wraps each item's own key; it does not read or change what people wrote. While it runs, `GET /api/health` says `"keyRotation": "in_progress"`, and the log says how far it has got.
4. When `/api/health` says `"keyRotation": "complete"` (and the log says `0 could not be opened`), remove `WAYMARK_ENCRYPTION_KEY_PREVIOUS` and restart. Everything opens with the new key alone.

Do not start another rotation until one is complete: the ring holds only two keys, and what is still under the first would be unreadable. Keep the old key as long as you keep a backup of the database or `/data` made before the rotation, since those are sealed under it.

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

## Directions

On a trip, _Directions_ hands a place over to the maps on the device; Waymark fetches nothing for it and sends no one's position anywhere. The device decides, and the convention is the same everywhere: on **Android** a `geo:` link
(`geo:<lat>,<lng>?q=<lat>,<lng>(<name>)`, opened by whichever maps app handles it); on **iPhone and iPad** (an iPad that asks for the desktop site included) Apple Maps, `maps://?daddr=<lat>,<lng>&q=<name>`; anywhere else an
OpenStreetMap directions link, `https://www.openstreetmap.org/directions?route=;<lat>,<lng>`, which opens in a browser. A place's name is one line of at most a hundred characters, percent-encoded, so a name cannot change the link.

## Licence

[AGPL-3.0-or-later](LICENSE), since it bundles `@sovereignfs/ui`.
