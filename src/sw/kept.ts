'use client';

import { keptKey } from '../map/offline';
import { dropTiles } from './tiles';

/** Everything this device kept of the account's trips' maps goes, at sign-out: the record and the files (DESIGN.md §14.5). Never throws: signing out does not wait on a browser that will not say. */
export async function forgetKeptMaps(accountId: string | undefined): Promise<void> {
  try {
    if (accountId) window.localStorage.removeItem(keptKey(accountId));
  } catch {
    // Nothing to remove from a browser that keeps nothing.
  }
  try {
    await dropTiles();
  } catch {
    // The worker is not there, so there is nothing of its to remove.
  }
}
