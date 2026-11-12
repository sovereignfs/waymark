// The development seed (DESIGN.md §25 Testing): accounts, and years of check-ins with photos, in the database the environment names, so that every screen has something to show.
//
//   pnpm seed
//
// It reads the same `.env` as `pnpm dev`, and refuses any database that is not plainly on this machine (src/seed/guard.ts). Run it twice and it makes nothing twice. The sources are TypeScript with
// extensionless imports, which Node does not load itself, so jiti does.
import { createJiti } from 'jiti';

if (typeof process.loadEnvFile === 'function') {
  try {
    process.loadEnvFile('.env');
  } catch {
    // no .env: the environment alone
  }
}
const jiti = createJiti(import.meta.url);
const { main } = await jiti.import('../src/seed/main.ts');
process.exit(await main({ nodeEnv: process.env.NODE_ENV }));
