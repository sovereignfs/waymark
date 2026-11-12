/**
 * Asks the browser to keep this device's database (`navigator.storage.persist()`; DESIGN.md §15.7): without it a browser under pressure may evict what has not been sent yet. **It is a request, and the
 * browser decides**: some grant it at once, some after the app is installed or used a while, some never, and nothing the app does changes the answer, so a refusal is not an error and is never shown. It asks
 * only if the browser has not already granted it, and only once for each load.
 */
export async function requestPersistence(
  storage: Pick<StorageManager, 'persist' | 'persisted'> | undefined = typeof navigator ===
  'undefined'
    ? undefined
    : navigator.storage,
): Promise<boolean | undefined> {
  if (!storage?.persist) return undefined;
  try {
    if (storage.persisted && (await storage.persisted())) return true;
    return await storage.persist();
  } catch {
    return undefined;
  }
}
