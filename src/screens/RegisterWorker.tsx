'use client';

import { useEffect } from 'react';

/**
 * Registers the service worker (DESIGN.md §20.12), once the page has loaded so that it does not compete with it. A development server's worker keeps nothing and
 * removes itself (`inertWorkerSource`), which is how this needs no ask of the environment. Failing to register is not an error to a person; the app works without.
 */
export function RegisterWorker() {
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
    void navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => undefined);
  }, []);
  return null;
}
