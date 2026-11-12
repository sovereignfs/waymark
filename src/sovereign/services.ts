import {
  CoreApiError,
  CoreUnavailableError,
  NotSupportedError,
  type Sovereign,
} from '@sovereignfs/sdk';

/**
 * **Core's services for the people who sign in through a core** (DESIGN.md §17.2, §19.4): its bell (`sv.app.notifications.send`), its email (`sv.app.email.sendToUser`) and a line on the person's own activity page
 * (`sv.app.activity.log`). **Each is an addition**: a call that fails, is refused or is not supported by an older core changes nothing but that call, and every feature works the same without it. So nothing here
 * throws: each call answers one of five words, as Tusk's channels do, and the caller decides what to do about it.
 *
 *  - `sent`           handed to core, which does not say whether the person got it (it says nothing of them).
 *  - `no_channel`     nothing to do: the person has no sub, or this core does not serve the service (`NotSupportedError`), or it is resting.
 *  - `not_permitted`  core refused this app (the scope is not granted, 403).
 *  - `retry_after`    core asked to be tried later, and says in how many seconds.
 *  - `failed`         it did not go: core was down, timed out or lost the answer.
 *
 * `sv.app` is **the app as itself**: it asks core for a token for the app and holds no person's token and no session, so it needs neither a token store nor a session store. **Every send carries a `key`** (a send with
 * the same key for the same person within a day is the same send at core), so a try that is repeated after a lost answer is not a second notification. A core that refuses or does not serve a service **is logged
 * once and then rested for `CORE_REST_MS`**, so a service that cannot work is tried rarely and fills no log. Text is cut to core's limits, and **nothing is logged but the service, and what became of it**: no title,
 * no body, no `sub`.
 */
export type Outcome = 'sent' | 'no_channel' | 'retry_after' | 'not_permitted' | 'failed';
export interface Result {
  readonly outcome: Outcome;
  readonly retryAfterSeconds?: number;
}

export const CORE_REST_MS = 6 * 60 * 60 * 1000;

export interface CoreServices {
  /** The person's bell at core. `url` is a whole address on one of the app's registered origins. */
  notify(input: {
    sub: string;
    title: string;
    body?: string;
    url: string;
    key: string;
  }): Promise<Result>;
  /** An email from core in its own template, to the person named by `sub`, without Waymark being given their address. */
  email(input: {
    sub: string;
    subject: string;
    body: string;
    link?: string;
    key: string;
  }): Promise<Result>;
  /** One line on the person's activity page at core. */
  activity(input: { sub: string; summary: string; link?: string; key: string }): Promise<Result>;
}

const cut = (text: string, most: number): string =>
  text.length <= most ? text : `${text.slice(0, most - 1).trimEnd()}…`;

export function coreServices(deps: {
  sovereign: Pick<Sovereign['app'], 'notifications' | 'email' | 'activity'>;
  now(): number;
  log?: (line: string) => void;
}): CoreServices {
  const restUntil: Record<string, number> = {};
  const rest = (service: string, why: string) => {
    if (deps.now() >= (restUntil[service] ?? 0)) deps.log?.(`core ${service}: ${why}; resting`);
    restUntil[service] = deps.now() + CORE_REST_MS;
  };
  async function guarded(service: string, send: () => Promise<unknown>): Promise<Result> {
    if (deps.now() < (restUntil[service] ?? 0)) return { outcome: 'no_channel' };
    try {
      await send();
      return { outcome: 'sent' };
    } catch (error) {
      if (error instanceof NotSupportedError) {
        rest(service, 'this core does not serve it');
        return { outcome: 'no_channel' };
      }
      if (error instanceof CoreApiError) {
        if (error.status === 403) {
          rest(service, 'this app may not use it');
          return { outcome: 'not_permitted' };
        }
        if (error.status === 429)
          return {
            outcome: 'retry_after',
            ...(error.retryAfter !== undefined ? { retryAfterSeconds: error.retryAfter } : {}),
          };
        return { outcome: 'failed' };
      }
      if (error instanceof CoreUnavailableError) return { outcome: 'failed' };
      return { outcome: 'failed' };
    }
  }
  return {
    notify: (input) =>
      guarded('notifications', () =>
        deps.sovereign.notifications.send({
          to: input.sub,
          title: cut(input.title, 120),
          ...(input.body ? { body: cut(input.body, 500) } : {}),
          url: input.url,
          category: 'info',
          key: input.key,
        }),
      ),
    email: (input) =>
      guarded('email', () =>
        deps.sovereign.email.sendToUser({
          to: input.sub,
          subject: cut(input.subject, 200),
          body: cut(input.body, 5000),
          ...(input.link ? { link: input.link } : {}),
          key: input.key,
        }),
      ),
    activity: (input) =>
      guarded('activity', () =>
        deps.sovereign.activity.log({
          to: input.sub,
          summary: cut(input.summary, 200),
          ...(input.link ? { link: input.link } : {}),
          key: input.key,
        }),
      ),
  };
}
