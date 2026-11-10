import { type SyncState, type Transport, syncOnce } from './sync';
import type { LocalStore } from './store';

/**
 * The loop that syncs (DESIGN.md §15.3): after a write (after a short pause, so that several writes are one request), on load, on focus, on coming online, and **every thirty seconds while the page
 * is visible**. **One tab at a time** syncs for an account: a tab asks for a Web Lock and does nothing if another holds it, and tells the others when something changed (`BroadcastChannel`), so that
 * they read the store again. Where there is no Web Lock the tab syncs anyway, which is safe: the server answers what it has already applied as a replay.
 *
 * Everything it needs from the browser is given to it (`LoopEnv`), so that a test can drive it with no browser.
 */
export interface LoopEnv {
  /** `navigator.locks.request` with `ifAvailable`: calls `work` if the lock was free, and says whether it was. */
  withLock(name: string, work: () => Promise<void>): Promise<boolean>;
  channel(name: string): {
    post(message: string): void;
    onMessage(handler: (message: string) => void): void;
    close(): void;
  };
  setTimer(handler: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  setInterval(handler: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
  /** Subscribes to a window event, and returns how to stop. */
  on(event: 'focus' | 'online' | 'visibilitychange', handler: () => void): () => void;
  visible(): boolean;
}

export interface Loop {
  /** A write was made: sync after the pause. */
  nudge(): void;
  /** Sync now, and say how it ended (for sign-out, which sends what it can first). Resolves `undefined` when another tab holds the lock. */
  syncNow(): Promise<SyncState | undefined>;
  stop(): void;
}

export const PAUSE_MS = 300;
export const EVERY_MS = 30_000;

export function startLoop(options: {
  accountId: string;
  store: LocalStore;
  transport: Transport;
  env: LoopEnv;
  /** Told after each run, and when another tab says it changed something: the screens read the store again. */
  onChange?: () => void;
  onState?: (state: SyncState) => void;
}): Loop {
  const { env, store, transport } = options;
  const lock = `waymark-sync-${options.accountId}`;
  const channel = env.channel(`waymark-${options.accountId}`);
  let timer: unknown;
  let stopped = false;
  let running: Promise<SyncState | undefined> | undefined;

  const run = (): Promise<SyncState | undefined> => {
    if (stopped) return Promise.resolve(undefined);
    // A run already going is the run: asking again at once is not another request.
    running ??= (async () => {
      let state: SyncState | undefined;
      const had = await env.withLock(lock, async () => {
        state = await syncOnce(store, transport);
      });
      if (had && state !== undefined) {
        options.onState?.(state);
        options.onChange?.();
        channel.post('changed');
      }
      return had ? state : undefined;
    })().finally(() => {
      running = undefined;
    });
    return running;
  };

  channel.onMessage((message) => {
    if (message === 'changed') options.onChange?.();
    if (message === 'wake') void run();
  });
  const unsubscribe = [
    env.on('focus', () => void run()),
    env.on('online', () => void run()),
    env.on('visibilitychange', () => {
      if (env.visible()) void run();
    }),
  ];
  const every = env.setInterval(() => {
    if (env.visible()) void run();
  }, EVERY_MS);
  void run();

  return {
    nudge() {
      if (stopped) return;
      if (timer !== undefined) env.clearTimer(timer);
      timer = env.setTimer(() => {
        timer = undefined;
        void run();
      }, PAUSE_MS);
      // The other tabs hold their own writes; one that wrote tells the tab that syncs.
      channel.post('wake');
    },
    syncNow: run,
    stop() {
      stopped = true;
      if (timer !== undefined) env.clearTimer(timer);
      env.clearInterval(every);
      for (const off of unsubscribe) off();
      channel.close();
    },
  };
}

/** The browser's own. */
export function browserEnv(): LoopEnv {
  return {
    async withLock(name, work) {
      if (typeof navigator === 'undefined' || !('locks' in navigator)) {
        await work();
        return true;
      }
      let had = false;
      await navigator.locks.request(name, { ifAvailable: true }, async (granted) => {
        if (!granted) return;
        had = true;
        await work();
      });
      return had;
    },
    channel(name) {
      if (typeof BroadcastChannel === 'undefined') return { post() {}, onMessage() {}, close() {} };
      const channel = new BroadcastChannel(name);
      return {
        post: (message) => channel.postMessage(message),
        onMessage: (handler) => {
          channel.onmessage = (event: MessageEvent) => handler(String(event.data));
        },
        close: () => channel.close(),
      };
    },
    setTimer: (handler, ms) => setTimeout(handler, ms),
    clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    setInterval: (handler, ms) => setInterval(handler, ms),
    clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
    on(event, handler) {
      const target = event === 'visibilitychange' ? document : window;
      target.addEventListener(event, handler);
      return () => target.removeEventListener(event, handler);
    },
    visible: () => document.visibilityState === 'visible',
  };
}
