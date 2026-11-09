/** Wait, for retries and polling. */
export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Run `attempt` until it succeeds or `timeoutMs` has passed, once a second. For
 * the moment a service is still starting: in a compose file the app and sqld (or
 * PostgreSQL) come up together, and the app should wait for it and not crash.
 * The last error is what the caller sees, so it says why the wait ended.
 */
export async function retryUntil<T>(
  attempt: () => Promise<T>,
  timeoutMs: number,
  intervalMs = 1000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return await attempt();
    } catch (error) {
      if (Date.now() + intervalMs > deadline) throw error;
      await sleep(intervalMs);
    }
  }
}
