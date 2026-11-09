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

## Licence

[AGPL-3.0-or-later](LICENSE), since it bundles `@sovereignfs/ui`.
