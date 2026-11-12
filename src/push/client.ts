/**
 * Web Push in the browser (DESIGN.md §17.3): turning it on for this device, and off. Everything the browser is asked for is given in (`PushEnv`), so that what this decides is tested without one. **The browser asks the person**: permission is
 * requested only when they press the button, never on load; a refusal is said in a sentence and nothing is subscribed. The subscription is sent to this app's own server (`/api/push`) and nowhere else.
 */
export type PushState = 'unsupported' | 'blocked' | 'off' | 'on';

export interface PushEnv {
  /** Whether this browser has a service worker, push and notifications. */
  supported(): boolean;
  permission(): 'default' | 'granted' | 'denied';
  requestPermission(): Promise<'default' | 'granted' | 'denied'>;
  /** This device's subscription, if it has one. */
  current(): Promise<{ endpoint: string } | null>;
  /** Subscribes this device to the server's key; the subscription as the browser gives it (`toJSON`). */
  subscribe(
    publicKey: string,
  ): Promise<{ endpoint: string; keys: { p256dh: string; auth: string } }>;
  /** Cancels this device's subscription. */
  unsubscribe(): Promise<void>;
  /** The app's own server. */
  send(method: 'POST' | 'DELETE', body: unknown): Promise<boolean>;
}

/** What to show: whether push can be turned on here, is blocked, is off or is on. */
export async function stateOf(env: PushEnv): Promise<PushState> {
  if (!env.supported()) return 'unsupported';
  if (env.permission() === 'denied') return 'blocked';
  return (await env.current()) ? 'on' : 'off';
}

/** Turns push on for this device: asks the person, subscribes, tells the server. Returns the state it ends in; on any failure nothing is left subscribed. */
export async function turnOn(env: PushEnv, publicKey: string): Promise<PushState | 'failed'> {
  if (!env.supported()) return 'unsupported';
  if (env.permission() === 'denied') return 'blocked';
  if (env.permission() === 'default') {
    const answer = await env.requestPermission();
    if (answer === 'denied') return 'blocked';
    if (answer !== 'granted') return 'off';
  }
  try {
    const subscription = await env.subscribe(publicKey);
    const stored = await env.send('POST', {
      endpoint: subscription.endpoint,
      keys: subscription.keys,
    });
    if (stored) return 'on';
    // The server would not have it: this device is not left subscribed to something it does not know of.
    await env.unsubscribe().catch(() => undefined);
    return 'failed';
  } catch {
    await env.unsubscribe().catch(() => undefined);
    return 'failed';
  }
}

/** Turns push off for this device: the server forgets it, then the browser cancels. */
export async function turnOff(env: PushEnv): Promise<PushState> {
  const current = await env.current();
  if (current) await env.send('DELETE', { endpoint: current.endpoint }).catch(() => false);
  await env.unsubscribe().catch(() => undefined);
  return 'off';
}

/** The browser's own, for the settings screen. */
export function browserEnv(): PushEnv {
  const registration = () => navigator.serviceWorker.ready;
  return {
    supported: () =>
      typeof navigator !== 'undefined' &&
      'serviceWorker' in navigator &&
      'PushManager' in window &&
      'Notification' in window,
    permission: () => Notification.permission,
    requestPermission: () => Notification.requestPermission(),
    current: async () => (await (await registration()).pushManager.getSubscription()) ?? null,
    subscribe: async (publicKey) => {
      const key = Uint8Array.from(atob(publicKey.replace(/-/g, '+').replace(/_/g, '/')), (c) =>
        c.charCodeAt(0),
      );
      const subscription = await (
        await registration()
      ).pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: key,
      });
      const json = subscription.toJSON();
      return {
        endpoint: subscription.endpoint,
        keys: { p256dh: json.keys?.p256dh ?? '', auth: json.keys?.auth ?? '' },
      };
    },
    unsubscribe: async () => {
      const subscription = await (await registration()).pushManager.getSubscription();
      await subscription?.unsubscribe();
    },
    send: async (method, body) => {
      const reply = await fetch('/api/push', {
        method,
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      return reply.ok;
    },
  };
}
