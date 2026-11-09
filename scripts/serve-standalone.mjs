// Starts the built app on a port, for the browser tests: `node scripts/serve-standalone.mjs <port>`. The database and every other setting come from
// the environment, as an operator gives them; this adds only the port, the address and where the migrations are.
import { spawn } from 'node:child_process';
import { migrationsDir, prepareStandalone } from './lib/standalone.mjs';

const port = process.argv[2];
if (!port) {
  console.error('usage: node scripts/serve-standalone.mjs <port>');
  process.exit(2);
}

const entry = prepareStandalone();
const server = spawn('node', [entry], {
  stdio: 'inherit',
  env: { ...process.env, PORT: port, HOSTNAME: '127.0.0.1', WAYMARK_MIGRATIONS_DIR: migrationsDir },
});
// Passed on, so that Playwright stopping its web server stops this one too.
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => server.kill(signal));
server.on('exit', (code, signal) => process.exit(code ?? (signal ? 143 : 1)));
