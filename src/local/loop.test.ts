import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import { type LoopEnv, EVERY_MS, PAUSE_MS, startLoop } from './loop';
import { openLocal } from './db';
import { LocalStore } from './store';
import type { SyncState, Transport } from './sync';

/**
 * The loop that syncs (DESIGN.md §15.3), driven with no browser: its triggers, one tab at a time, and the tabs told. The time is the test's, and so are the events.
 */
const emptyAnswer = {
  protocol: 1,
  results: [],
  account: {
    places: [],
    checkins: [],
    deleted: [],
    cursor: 0,
    more: false,
    head: 0,
    floor: 0,
    reset: false,
  },
};

/** A browser that is a few functions: a lock that another tab may hold, a channel shared with other tabs, a clock of its own, and events it fires. */
function browser(shared: { held: boolean; messages: Map<string, ((m: string) => void)[]> }) {
  const timers: { at: number; handler: () => void; id: number }[] = [];
  const intervals: { every: number; handler: () => void; id: number }[] = [];
  const listeners = new Map<string, Set<() => void>>();
  let now = 0;
  let ids = 0;
  let visible = true;
  const env: LoopEnv = {
    async withLock(_name, work) {
      if (shared.held) return false;
      shared.held = true;
      try {
        await work();
      } finally {
        shared.held = false;
      }
      return true;
    },
    channel(name) {
      const mine: ((m: string) => void)[] = [];
      return {
        post: (message) => {
          for (const handler of shared.messages.get(name) ?? [])
            if (!mine.includes(handler)) handler(message);
        },
        onMessage: (handler) => {
          mine.push(handler);
          shared.messages.set(name, [...(shared.messages.get(name) ?? []), handler]);
        },
        close: () => {
          shared.messages.set(
            name,
            (shared.messages.get(name) ?? []).filter((h) => !mine.includes(h)),
          );
        },
      };
    },
    setTimer: (handler, ms) => {
      const id = ++ids;
      timers.push({ at: now + ms, handler, id });
      return id;
    },
    clearTimer: (handle) => {
      const at = timers.findIndex((t) => t.id === handle);
      if (at >= 0) timers.splice(at, 1);
    },
    setInterval: (handler, ms) => {
      const id = ++ids;
      intervals.push({ every: ms, handler, id });
      return id;
    },
    clearInterval: (handle) => {
      const at = intervals.findIndex((t) => t.id === handle);
      if (at >= 0) intervals.splice(at, 1);
    },
    on: (event, handler) => {
      const set = listeners.get(event) ?? new Set();
      set.add(handler);
      listeners.set(event, set);
      return () => set.delete(handler);
    },
    visible: () => visible,
  };
  return {
    env,
    advance(ms: number) {
      now += ms;
      for (const timer of timers.filter((t) => t.at <= now)) {
        timers.splice(timers.indexOf(timer), 1);
        timer.handler();
      }
    },
    tick: () => intervals.forEach((i) => i.handler()),
    fire: (event: string) => listeners.get(event)?.forEach((h) => h()),
    hide: () => {
      visible = false;
    },
    listeners: () => [...listeners.values()].reduce((n, s) => n + s.size, 0),
    intervals: () => intervals.length,
    timers: () => timers.length,
  };
}

async function setup() {
  (globalThis as { indexedDB?: IDBFactory }).indexedDB = new IDBFactory();
  const store = new LocalStore(await openLocal(`loop${Math.random().toString(36).slice(2)}`));
  const sent: unknown[] = [];
  const transport: Transport = async (body) => {
    sent.push(body);
    return { status: 200, json: emptyAnswer };
  };
  return { store, sent, transport };
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

describe('the sync loop', () => {
  it('syncs on load, and tells the screens and the other tabs', async () => {
    const { store, sent, transport } = await setup();
    const shared = { held: false, messages: new Map() };
    const b = browser(shared);
    const heard: string[] = [];
    const states: SyncState[] = [];
    let changes = 0;
    const other = browser(shared).env.channel('waymark-a');
    other.onMessage((m) => heard.push(m));
    const loop = startLoop({
      accountId: 'a',
      store,
      transport,
      env: b.env,
      onChange: () => changes++,
      onState: (s) => states.push(s),
    });
    await settle();
    expect(sent).toHaveLength(1);
    expect(states).toEqual(['ok']);
    expect(changes).toBe(1);
    expect(heard).toEqual(['changed']);
    loop.stop();
  });

  it('syncs after a write, once, after a short pause, however many writes there were', async () => {
    const { store, sent, transport } = await setup();
    const b = browser({ held: false, messages: new Map() });
    const loop = startLoop({ accountId: 'a', store, transport, env: b.env });
    await settle();
    sent.length = 0;
    loop.nudge();
    loop.nudge();
    loop.nudge();
    b.advance(PAUSE_MS - 1);
    await settle();
    expect(sent).toHaveLength(0);
    b.advance(1);
    await settle();
    expect(sent).toHaveLength(1);
    loop.stop();
  });

  it('syncs when the page gets the focus, when the network comes back, and when it becomes visible, and every thirty seconds only while it is', async () => {
    const { store, sent, transport } = await setup();
    const b = browser({ held: false, messages: new Map() });
    const loop = startLoop({ accountId: 'a', store, transport, env: b.env });
    await settle();
    for (const event of ['focus', 'online', 'visibilitychange']) {
      sent.length = 0;
      b.fire(event);
      await settle();
      expect(sent, event).toHaveLength(1);
    }
    sent.length = 0;
    b.tick();
    await settle();
    expect(sent).toHaveLength(1);
    expect(EVERY_MS).toBe(30_000);
    b.hide();
    sent.length = 0;
    b.tick();
    b.fire('visibilitychange'); // hidden now: not a reason to sync
    await settle();
    expect(sent).toHaveLength(0);
    loop.stop();
  });

  it('does not start a second run while one is going, and does not lose the question: one more run follows, shared by all who asked meanwhile', async () => {
    const { store, sent } = await setup();
    const releases: (() => void)[] = [];
    const slow: Transport = async (body) => {
      sent.push(body);
      await new Promise<void>((resolve) => releases.push(resolve));
      return { status: 200, json: emptyAnswer };
    };
    const b = browser({ held: false, messages: new Map() });
    const loop = startLoop({ accountId: 'a', store, transport: slow, env: b.env });
    await settle();
    expect(sent).toHaveLength(1); // the run on load, still going
    const [one, two] = [loop.syncNow(), loop.syncNow()];
    b.fire('focus');
    b.fire('online');
    await settle();
    expect(sent).toHaveLength(1); // not a second at the same time
    releases.shift()?.();
    await settle();
    expect(sent).toHaveLength(2); // the one more that follows, for what was asked meanwhile
    releases.shift()?.();
    expect(await one).toBe('ok');
    expect(await two).toBe('ok');
    await settle();
    expect(sent).toHaveLength(2); // and not a third
    loop.stop();
  });

  it('sends what was recorded while a run was going, without waiting for the next trigger', async () => {
    const { store, sent } = await setup();
    const releases: (() => void)[] = [];
    const slow: Transport = async (body) => {
      sent.push(body);
      await new Promise<void>((resolve) => releases.push(resolve));
      return { status: 200, json: emptyAnswer };
    };
    const b = browser({ held: false, messages: new Map() });
    const loop = startLoop({ accountId: 'a', store, transport: slow, env: b.env });
    await settle();
    const mutation = {
      mutationId: 'late',
      stream: 'account' as const,
      changes: [{ table: 'checkin' as const, op: 'delete' as const, id: 'x' }],
    };
    await store.record(mutation); // written after the run read the outbox
    b.fire('focus');
    releases.shift()?.();
    await settle();
    expect((sent[1] as { outbox: unknown[] }).outbox).toEqual([mutation]);
    releases.shift()?.();
    loop.stop();
  });

  it('uploads the photos after the changes, and tries a photo again at once when the network comes back, whatever was left of its backoff', async () => {
    const { store, sent, transport } = await setup();
    const uploads: string[] = [];
    const put = async (id: string) => {
      uploads.push(id);
      return { status: 201, json: {} };
    };
    const b = browser({ held: false, messages: new Map() });
    await store.addPhoto(
      '11111111-1111-4111-8111-111111111111',
      new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }),
    );
    await store.photoFailed('11111111-1111-4111-8111-111111111111', Date.now()); // five seconds of backoff
    const loop = startLoop({ accountId: 'a', store, transport, put, env: b.env });
    await settle();
    expect(sent).toHaveLength(1);
    expect(uploads).toEqual([]); // the backoff is not over
    b.fire('online');
    await settle();
    expect(uploads).toEqual(['11111111-1111-4111-8111-111111111111']);
    expect(await store.photoCount()).toBe(0);
    loop.stop();
  });

  it('does nothing in a tab when another tab holds the lock, and says so', async () => {
    const { store, sent, transport } = await setup();
    const shared = { held: true, messages: new Map() };
    const b = browser(shared);
    const loop = startLoop({ accountId: 'a', store, transport, env: b.env });
    await settle();
    expect(sent).toHaveLength(0);
    expect(await loop.syncNow()).toBeUndefined();
    shared.held = false;
    expect(await loop.syncNow()).toBe('ok');
    loop.stop();
  });

  it('reads the store again when another tab says it changed, and syncs when another tab says it wrote', async () => {
    const { store, sent, transport } = await setup();
    const shared = { held: false, messages: new Map() };
    const b = browser(shared);
    let changes = 0;
    const loop = startLoop({
      accountId: 'a',
      store,
      transport,
      env: b.env,
      onChange: () => changes++,
    });
    await settle();
    sent.length = 0;
    changes = 0;
    const other = browser(shared).env.channel('waymark-a');
    other.post('changed');
    expect(changes).toBe(1);
    expect(sent).toHaveLength(0);
    other.post('wake');
    await settle();
    expect(sent).toHaveLength(1);
    loop.stop();
  });

  it('stops: no more timers, intervals or listeners, and nothing is sent', async () => {
    const { store, sent, transport } = await setup();
    const b = browser({ held: false, messages: new Map() });
    const loop = startLoop({ accountId: 'a', store, transport, env: b.env });
    await settle();
    loop.nudge();
    loop.stop();
    expect([b.timers(), b.intervals(), b.listeners()]).toEqual([0, 0, 0]);
    sent.length = 0;
    b.advance(10_000);
    b.fire('focus');
    expect(await loop.syncNow()).toBeUndefined();
    await settle();
    expect(sent).toHaveLength(0);
  });
});
