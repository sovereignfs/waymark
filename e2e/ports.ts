/**
 * Every port the browser tests use, each shifted by `WAYMARK_E2E_PORT_OFFSET`, so that several runs can share a machine: `scripts/e2e-shard.mjs` gives each of its
 * shards a hundred of its own, and each then has its own instances, databases and fake services. With none set they are the ports the tests have always used.
 * Plain TypeScript with no syntax Node cannot strip, since a fake service run by Node reads this too.
 */
const offset = Number(process.env.WAYMARK_E2E_PORT_OFFSET ?? 0);
if (!Number.isInteger(offset) || offset < 0 || offset > 20_000) {
  throw new Error('WAYMARK_E2E_PORT_OFFSET must be a whole number from 0 to 20000');
}

export const PORTS = {
  /** The app under test, on the database the environment names. */
  app: 4005 + offset,
  /** The instance with no way of signing in (`e2e/auth.spec.ts`): its sign-in pages and routes do not exist. */
  off: 4004 + offset,
  /** The fake place search (`src/places/fake.ts`): the main instance's provider, so that the browser tests search with nothing reaching the internet. */
  places: 4006 + offset,
} as const;
