# Running Waymark

Waymark is one image that runs on its own or hosted by a Sovereign instance. This folder is the first way: three setups, one for each form of
database. They are the same app; only where it keeps its data differs (`DESIGN.md` §24.1).

| Setup                  | Files                                    | The database                                         | For                                                                                                                                                             |
| ---------------------- | ---------------------------------------- | ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **sqld** (the default) | `compose.yaml`                           | An sqld service (libSQL's server), on its own volume | Most installs. The app holds no state of its own in the database's place, and operating it is the same as operating Sovereign                                   |
| **A file**             | `compose.file.yaml`                      | One SQLite file on a volume                          | The smallest: one container, one person or a small group. A second instance cannot share the file, and it must stay on a local disk, never a network filesystem |
| **PostgreSQL**         | `compose.yaml` + `compose.postgres.yaml` | PostgreSQL, or one you already run                   | An operator who prefers it, or has one                                                                                                                          |

Whatever the database, **`/data`** is where everything else lives: the database file in the file setup, and the photos and files people add, the imports and
the map's cache. It is a volume in every setup here; back it up with the database.

## Start

```bash
cd deploy
cp .env.example .env     # then edit it: at least WAYMARK_URL, WAYMARK_AUTH_SECRET and WAYMARK_ENCRYPTION_KEY
docker compose up -d --build                                                   # sqld
docker compose -f compose.file.yaml up -d --build                              # a file
docker compose -f compose.yaml -f compose.postgres.yaml up -d --build          # PostgreSQL (Compose 2.24 or later)
```

Only the machine itself can reach the port (`127.0.0.1:3005`): put a reverse proxy with TLS in front of it, and set `WAYMARK_URL` to the address people use.
Passkeys, emailed links and the sign-in redirect are made from it, and the server refuses to start on an address that is not https (localhost aside).

The smallest setup of all is one `docker run`, with no Compose:

```bash
docker run -d -p 127.0.0.1:3005:3005 -v waymark:/data \
  -e WAYMARK_DB_DIALECT=sqlite -e WAYMARK_SQLITE_URL=file:/data/waymark.db \
  -e WAYMARK_URL=https://waymark.example.com -e WAYMARK_AUTH_LOCAL=1 \
  -e WAYMARK_AUTH_SECRET="$(openssl rand -base64 48)" -e WAYMARK_ENCRYPTION_KEY="$(openssl rand -base64 32)" \
  ghcr.io/sovereignfs/waymark
```

(Keep the two generated values: they are in no file, so make them once and put them in your own secrets.)

## What the server does when it starts

It checks its settings and stops, naming every one that is wrong and never its value. It then makes the places its database lives in (an sqld
namespace, a directory, a PostgreSQL schema), waits for a database that is still starting (up to `WAYMARK_DB_CONNECT_TIMEOUT_MS`, 30 seconds), applies
its own migrations, and starts. It does not start if it cannot, and `GET /api/health` answers 200 only when the database does. Migrations apply once
each, and a second process starting at the same time is safe.

It stops on SIGTERM within seconds and exits 143.

## Your own PostgreSQL

Skip `compose.postgres.yaml` and set, in `.env`:

```
WAYMARK_DB_DIALECT=postgres
WAYMARK_POSTGRES_URL=postgres://user:password@host:5432/waymark
```

(or `WAYMARK_POSTGRES_URL_FILE`, a file holding it). The app makes its own schemas, `waymark` and `waymark_auth`, in that database.

## On a Sovereign instance

`sv app add` hosts Waymark from `sovereign.manifest.json`, which is also the image's label: the instance builds nothing of its own, gives the app a database
and `/data`, and tells it where it is. What it sets is the settings above under Waymark's own names: `WAYMARK_URL`, `WAYMARK_CORE_URL`, `WAYMARK_CORE_CLIENT_ID` and
`WAYMARK_CORE_CLIENT_SECRET` (or `_FILE`), the database (`WAYMARK_DB_DIALECT` and its address) and `PORT`, and it makes `WAYMARK_AUTH_SECRET`,
`WAYMARK_ENCRYPTION_KEY` and `WAYMARK_VAPID_PRIVATE_KEY` once and keeps them. With `WAYMARK_AUTH_LOCAL` unset, people sign in through the instance only: there is no password, sign-up or reset to find.

## Keys

There are two keys, and they are different things.

- **`WAYMARK_AUTH_SECRET`** signs sessions and tokens. Changing it signs everyone out. Make it once (`openssl rand -base64 48`) and keep it with your secrets.
- **`WAYMARK_ENCRYPTION_KEY`** seals everything that says where or what: places, notes, titles, names and every file (`DESIGN.md` §18). **Keep it: without it the data
  cannot be read, and nothing can recover it.** Keep it apart from the backups of the database and `/data`. It protects against a copied database, a stolen disk or a
  backup; it does not hide anything from whoever runs the server, which has the key. **To change it**, put the new one in `WAYMARK_ENCRYPTION_KEY` and the old in
  `WAYMARK_ENCRYPTION_KEY_PREVIOUS`, start the server, and when it has moved everything to the new key, remove the old one.

## Backups

The database and `/data` are the whole of it, apart from the key above.

- **sqld:** a snapshot of the `sqld-data` volume, taken with sqld stopped or by your usual volume backup, and of `/data`.
- **A file:** a snapshot of the volume. For a running copy, `sqlite3 /data/waymark.db ".backup /backup/waymark.db"`, or continuous replication such as Litestream. The
  auth database, `waymark_auth.db`, is beside it and is part of it.
- **PostgreSQL:** `pg_dump`, or your usual process, and a snapshot of `/data`.

Each person can also export their own data from Settings, which is neither a substitute for these nor the reverse.

## Updating

Pull or build the new image and `docker compose up -d`. Migrations apply when the new server starts. A patch release has none and changes no setting; a
minor may, and going back is restoring the backup you took before it. **0.1.0 is the first release**, so there is nothing to update from; take the backup before the update after it.

## Checking a setup

`scripts/deploy-check.sh` brings each setup up from nothing, checks the database it is on, restarts it, and stops it with SIGTERM, and CI runs it. Its last setup,
`sovereign`, is an instance hosting the app (secrets as files, a PostgreSQL of its own, a port that is not the image's): it checks that the image's label is the
manifest, that the icon answers, and that it stops on SIGTERM:

```bash
eval "docker build $(pnpm exec sovereign-manifest docker-args) -t waymark:ci ."
WAYMARK_IMAGE=waymark:ci scripts/deploy-check.sh
```
