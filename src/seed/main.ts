import { getConfig } from '../config/current';
import { serverSealer } from '../crypto/server';
import { getStores } from '../db/boot';
import { developmentProblems } from './guard';
import { ACCOUNTS, SEED_PASSWORD, runSeed } from './run';

/**
 * `pnpm seed`: reads the settings as the server does (the same `.env`), refuses a database that is not plainly a development one, brings the database up and migrates it as the server would, and seeds
 * it. Returns the exit code. `NODE_ENV` is given by the script, since settings are read only in `src/config`.
 */
export async function main(options: {
  nodeEnv: string | undefined;
  log?: (line: string) => void;
}): Promise<number> {
  const log = options.log ?? console.log;
  const config = getConfig();
  const problems = developmentProblems({
    nodeEnv: options.nodeEnv,
    url: config.url,
    database: config.database.database,
    dataDir: config.media.dataDir,
  });
  if (problems.length > 0) {
    log('The seed will not run here:');
    for (const problem of problems) log(`  - ${problem}`);
    return 1;
  }
  if (!config.auth?.local) {
    log(
      'The seed signs accounts up with a password, so local sign-in must be on (WAYMARK_AUTH_LOCAL=1 and WAYMARK_AUTH_SECRET).',
    );
    return 1;
  }
  const stores = await getStores();
  try {
    await runSeed({
      app: stores.app,
      auth: stores.auth,
      sealer: serverSealer(),
      ring: config.encryption,
      settings: config.auth,
      dataDir: config.media.dataDir,
      maxAccountBytes: config.media.maxAccountBytes,
      now: Date.now,
      log,
    });
  } finally {
    await stores.close();
  }
  log('');
  log('Sign in at the address people use with any of:');
  for (const account of ACCOUNTS) log(`  ${account.email}  (${account.life})`);
  log(`The password is ${SEED_PASSWORD} for each.`);
  return 0;
}
