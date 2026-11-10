import { randomBytes } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkInAtNewPlace, checkInAtPlace, deleteCheckin, editCheckin } from '../actions/checkins';
import { createPlace, deletePlace, updatePlace } from '../actions/places';
import type { CheckinView, Context, PlaceView } from '../actions/types';
import { ringOf } from '../crypto/keys';
import { Sealer } from '../crypto/sealed';
import type { Database } from '../db/client';
import { dbAll } from '../db/exec';
import { makeStore, testTarget } from '../db/test-support';
import { type ApplyDeps, applyMutation } from './apply';
import type { Mutation } from './format';

/**
 * **The property test of applying** (DESIGN.md §15.4): two devices of one account do random things (make, edit, move and delete check-ins and places, from the same starting point), their
 * outboxes reach the server in a random interleaving that keeps each device's own order, and some mutations arrive twice. Whatever the order, **the server's rows are exactly what a plain model
 * of the rules gives for that order** (the later edit stands whole; a delete of what is gone is nothing; a check-in at a place that was deleted meanwhile is refused; a place with check-ins is
 * not deleted), a replay of everything changes nothing, and every number in the stream is used once and the stream ends where the changes say. The model is a few lines and has nothing in
 * common with the SQL, which is the point.
 */
const { leg } = testTarget();
const ring = ringOf(randomBytes(32));
if (!ring) throw new Error('no ring');
const sealer = new Sealer(ring);
let database: Database;
let close: () => Promise<void>;
let deps: ApplyDeps;
const NOW = 1_800_000_000_000;
beforeAll(async () => {
  ({ database, close } = await makeStore());
  deps = { database, sealer, now: () => NOW };
});
afterAll(async () => close());
const tbl = (name: string) => sql.raw(database.dialect === 'postgres' ? `waymark.${name}` : name);

/** A small seeded generator, so that a failing seed is a failure that can be run again. */
function random(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (n: number) => Math.floor(next() * n),
    pick: <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)] as T,
  };
}

interface ModelPlace {
  name: string;
  version: number;
}
interface ModelCheckin {
  placeId: string;
  note: string | undefined;
  at: number;
  version: number;
}
/** What the rules say, written the plain way: state, and one function for a mutation. */
class Model {
  places = new Map<string, ModelPlace>();
  checkins = new Map<string, ModelCheckin>();
  dead = new Set<string>(); // `table/id` of what was deleted and not made again
  applied = new Set<string>();
  stream = 0;
  apply(m: Mutation): 'applied' | 'replay' | 'refused' {
    if (this.applied.has(m.mutationId)) return 'replay';
    const places = new Map([...this.places].map(([k, v]) => [k, { ...v }]));
    const checkins = new Map([...this.checkins].map(([k, v]) => [k, { ...v }]));
    const dead = new Set(this.dead);
    for (const c of m.changes) {
      if (c.table === 'place' && c.op === 'put') {
        const before = places.get(c.id);
        places.set(c.id, { name: c.row.name, version: (before?.version ?? 0) + 1 });
        dead.delete(`place/${c.id}`);
      } else if (c.table === 'checkin' && c.op === 'put') {
        if (!places.has(c.row.placeId)) return 'refused';
        const before = checkins.get(c.id);
        checkins.set(c.id, {
          placeId: c.row.placeId,
          note: c.row.note,
          at: c.row.at,
          version: (before?.version ?? 0) + 1,
        });
        dead.delete(`checkin/${c.id}`);
      } else if (c.table === 'checkin') {
        if (checkins.delete(c.id)) dead.add(`checkin/${c.id}`);
      } else if (places.has(c.id)) {
        if ([...checkins.values()].some((k) => k.placeId === c.id)) return 'refused';
        places.delete(c.id);
        dead.add(`place/${c.id}`);
      }
    }
    this.places = places;
    this.checkins = checkins;
    this.dead = dead;
    this.applied.add(m.mutationId);
    this.stream += m.changes.length;
    return 'applied';
  }
}

/** One device: what it holds, and what it does at random, each action made by the real actions from what it holds. */
class Device {
  outbox: Mutation[] = [];
  private serial = 0;
  constructor(
    readonly name: string,
    private readonly rng: ReturnType<typeof random>,
    public places: Map<string, PlaceView>,
    public checkins: Map<string, CheckinView>,
  ) {}
  private ctx(): Context {
    return {
      ids: { newId: () => `${this.name}-${++this.serial}-${this.rng.int(1e9)}` },
      now: NOW,
      deviceZone: 'Europe/Lisbon',
    };
  }
  private note() {
    return `note ${this.rng.int(1000)}`;
  }
  step() {
    const ctx = this.ctx();
    const places = [...this.places.values()];
    const checkins = [...this.checkins.values()];
    const kind = this.rng.pick([
      'edit',
      'edit',
      'move',
      'delete',
      'new',
      'at',
      'place',
      'rename',
      'drop',
    ]);
    let result;
    if (kind === 'edit' && checkins.length > 0)
      result = editCheckin(this.rng.pick(checkins), { note: this.note() }, ctx);
    else if (kind === 'move' && checkins.length > 0 && places.length > 0)
      result = editCheckin(this.rng.pick(checkins), { place: this.rng.pick(places) }, ctx);
    else if (kind === 'delete' && checkins.length > 0)
      result = deleteCheckin(this.rng.pick(checkins), ctx);
    else if (kind === 'at' && places.length > 0)
      result = checkInAtPlace(this.rng.pick(places), { note: this.note() }, ctx);
    else if (kind === 'new')
      result = checkInAtNewPlace(
        {
          name: `Place ${this.rng.int(1000)}`,
          lat: 38 + this.rng.next(),
          lng: -9 - this.rng.next(),
        },
        { note: this.note() },
        ctx,
      );
    else if (kind === 'place')
      result = createPlace(
        {
          name: `Spot ${this.rng.int(1000)}`,
          lat: 38 + this.rng.next(),
          lng: -9 - this.rng.next(),
        },
        ctx,
      );
    else if (kind === 'rename' && places.length > 0)
      result = updatePlace(this.rng.pick(places), { name: `Renamed ${this.rng.int(1000)}` }, ctx);
    else if (kind === 'drop' && places.length > 0)
      result = deletePlace(this.rng.pick(places), checkins, ctx);
    if (!result?.ok) return;
    this.outbox.push(result.mutation);
    // What the device now shows: its own change, at once.
    for (const c of result.mutation.changes) {
      if (c.table === 'place' && c.op === 'put')
        this.places.set(c.id, {
          ...c.row,
          id: c.id,
          version: (this.places.get(c.id)?.version ?? 0) + 1,
        } as PlaceView);
      else if (c.table === 'checkin' && c.op === 'put')
        this.checkins.set(c.id, {
          ...c.row,
          id: c.id,
          version: (this.checkins.get(c.id)?.version ?? 0) + 1,
        } as CheckinView);
      else if (c.table === 'checkin') this.checkins.delete(c.id);
      else this.places.delete(c.id);
    }
  }
}

const copy = <K, V>(m: Map<K, V>) =>
  new Map([...m].map(([k, v]) => [k, structuredClone(v)] as const));

async function serverState(accountId: string) {
  const places = await dbAll<{
    id: string;
    version: number | string;
    sealed: Uint8Array | ArrayBuffer;
    seq: number | string;
  }>(
    database,
    sql`SELECT id, version, seq, sealed FROM ${tbl('place')} WHERE account_id = ${accountId} ORDER BY id`,
  );
  const checkins = await dbAll<{
    id: string;
    placeId: string;
    at: number | string;
    version: number | string;
    seq: number | string;
    sealed: Uint8Array | ArrayBuffer;
  }>(
    database,
    sql`SELECT id, place_id AS "placeId", at, version, seq, sealed FROM ${tbl('checkin')} WHERE account_id = ${accountId} ORDER BY id`,
  );
  const bytes = (b: Uint8Array | ArrayBuffer) => (b instanceof Uint8Array ? b : new Uint8Array(b));
  const stones = await dbAll<{ tableName: string; rowId: string }>(
    database,
    sql`SELECT table_name AS "tableName", row_id AS "rowId" FROM ${tbl('tombstone')} WHERE account_id = ${accountId}`,
  );
  const stream = await dbAll<{ seq: number | string }>(
    database,
    sql`SELECT seq FROM ${tbl('account_stream')} WHERE account_id = ${accountId}`,
  );
  return {
    places: places.map((p) => ({
      id: p.id,
      name: sealer.unseal('place', p.id, bytes(p.sealed)).name,
      version: Number(p.version),
      seq: Number(p.seq),
    })),
    checkins: checkins.map((c) => ({
      id: c.id,
      placeId: c.placeId,
      note: sealer.unseal('checkin', c.id, bytes(c.sealed)).note,
      at: Number(c.at),
      version: Number(c.version),
      seq: Number(c.seq),
    })),
    dead: new Set(stones.map((s) => `${s.tableName}/${s.rowId}`)),
    stream: Number(stream[0]?.seq ?? 0),
  };
}

describe(`applying, over random sequences on two devices (${leg})`, () => {
  const SEEDS = Array.from({ length: 20 }, (_, i) => 1000 + i * 7919);
  it.each(SEEDS)(
    'ends with the rows the rules give for the order they arrived in, whatever it was (seed %i)',
    async (seed) => {
      const rng = random(seed);
      const account = `prop-${seed}`;
      const model = new Model();

      // The starting point both devices have: three places and five check-ins, applied first.
      const start: Mutation[] = [];
      let n = 0;
      const sctx: Context = {
        ids: { newId: () => `base${seed}-${++n}` },
        now: NOW,
        deviceZone: 'Europe/Lisbon',
      };
      const basePlaces: PlaceView[] = [];
      for (let i = 0; i < 3; i++) {
        const made = createPlace({ name: `Base ${i}`, lat: 38 + i / 10, lng: -9 }, sctx);
        if (!made.ok) throw new Error(made.sentence);
        start.push(made.mutation);
        const change = made.mutation.changes[0];
        if (change?.table === 'place' && change.op === 'put')
          basePlaces.push({ ...change.row, id: change.id, version: 1 } as PlaceView);
      }
      const baseCheckins: CheckinView[] = [];
      for (let i = 0; i < 5; i++) {
        const made = checkInAtPlace(basePlaces[i % 3], { note: `base ${i}` }, sctx);
        if (!made.ok) throw new Error(made.sentence);
        start.push(made.mutation);
        const change = made.mutation.changes[0];
        if (change?.table === 'checkin' && change.op === 'put')
          baseCheckins.push({ ...change.row, id: change.id, version: 1 } as CheckinView);
      }
      for (const m of start) {
        expect(model.apply(m)).toBe('applied');
        expect((await applyMutation(deps, account, m)).status).toBe('applied');
      }

      const devices = ['a', 'b'].map(
        (name) =>
          new Device(
            name,
            rng,
            copy(new Map(basePlaces.map((p) => [p.id, p]))),
            copy(new Map(baseCheckins.map((c) => [c.id, c]))),
          ),
      );
      for (const device of devices) for (let i = 0; i < 12; i++) device.step();

      // The order they arrive in: random, each device's own order kept; and some arrive again.
      const queues = devices.map((d) => [...d.outbox]);
      const arrivals: Mutation[] = [];
      while (queues.some((q) => q.length > 0)) {
        const live = queues.filter((q) => q.length > 0);
        const queue = rng.pick(live);
        const m = queue.shift() as Mutation;
        arrivals.push(m);
        if (rng.next() < 0.25) arrivals.push(m);
      }
      for (const m of arrivals) {
        const expected = model.apply(m);
        const got = await applyMutation(deps, account, m);
        expect(
          got.status,
          `${m.mutationId} ${JSON.stringify(m.changes.map((c) => `${c.table} ${c.op}`))}`,
        ).toBe(expected);
      }

      const server = await serverState(account);
      expect(server.places.map((p) => [p.id, p.name, p.version])).toEqual(
        [...model.places]
          .map(([id, p]) => [id, p.name, p.version])
          .sort((x, y) => String(x[0]).localeCompare(String(y[0]))),
      );
      expect(server.checkins.map((c) => [c.id, c.placeId, c.note, c.at, c.version])).toEqual(
        [...model.checkins]
          .map(([id, c]) => [id, c.placeId, c.note, c.at, c.version])
          .sort((x, y) => String(x[0]).localeCompare(String(y[0]))),
      );
      expect([...server.dead].sort()).toEqual([...model.dead].sort());
      // The numbers: the stream ends where the changes say, and no two rows were stamped with the same one.
      expect(server.stream).toBe(model.stream);
      const stamped = [...server.places.map((p) => p.seq), ...server.checkins.map((c) => c.seq)];
      expect(new Set(stamped).size).toBe(stamped.length);
      expect(Math.max(0, ...stamped)).toBeLessThanOrEqual(server.stream);

      // Everything again: nothing changes.
      // (A mutation that was refused is not one that was applied: it is judged again, by what is there then.)
      for (const m of [...start, ...arrivals].filter((each) => model.applied.has(each.mutationId)))
        expect((await applyMutation(deps, account, m)).status).toBe('replay');
      expect(await serverState(account)).toEqual(server);
    },
    60_000,
  );
});
