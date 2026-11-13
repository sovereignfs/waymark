import type { Context } from '../actions/types';

/** What an action is given that it must not read for itself (`actions/types.ts`): ids, the time and the zone the device is in. */
export const actionContext = (): Context => ({
  ids: { newId: () => crypto.randomUUID() },
  now: Date.now(),
  deviceZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
});
