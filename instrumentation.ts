/**
 * Runs once when the server starts. It only hands over to the Node file: Next compiles this one for the Edge runtime too, where the process
 * and the database must not be seen.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { start } = await import('./instrumentation-node');
    await start();
  }
}
