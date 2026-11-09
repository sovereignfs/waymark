// Start a built instance of the app against whatever database the environment names, and ask it whether it is up. This is the check that "a
// fresh instance boots from the documented variables" (task 1.5): the server provisions and migrates the database itself at start-up, so all
// it is given is WAYMARK_DB_DIALECT and WAYMARK_SQLD_URL / WAYMARK_SQLD_ADMIN_URL, WAYMARK_SQLITE_URL or WAYMARK_POSTGRES_URL, exactly as an operator
// would.
//
//   pnpm build && pnpm boot-check
//
// Exits 0 if /api/health answers ok on the expected dialect, 1 otherwise.
import { spawn } from 'node:child_process';
import { migrationsDir, prepareStandalone } from './lib/standalone.mjs';

const port = process.env.BOOT_CHECK_PORT ?? '3999';
// Health says `sqlite` for both of SQLite's forms, an sqld service and a file.
const configured = (process.env.WAYMARK_DB_DIALECT || 'sqld').trim().toLowerCase();
const expectedDialect = configured === 'postgres' ? 'postgres' : 'sqlite';
const deadline = Date.now() + Number(process.env.BOOT_CHECK_TIMEOUT_MS ?? 90_000);

let entry;
try {
  entry = prepareStandalone();
} catch (error) {
  console.log(error.message);
  process.exit(1);
}

// The standalone server takes its port and address from the environment.
const server = spawn('node', [entry], {
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, PORT: port, HOSTNAME: '127.0.0.1', WAYMARK_MIGRATIONS_DIR: migrationsDir },
});
let log = '';
server.stdout.on('data', (chunk) => (log += chunk));
server.stderr.on('data', (chunk) => (log += chunk));
let exited = false;
server.on('exit', () => (exited = true));

function finish(code, message) {
  console.log(message);
  if (code !== 0) console.log(`--- server output ---\n${log}`);
  server.kill('SIGTERM');
  // Give it a moment to close its database connections before the process ends.
  setTimeout(() => process.exit(code), 500);
}

while (Date.now() < deadline) {
  if (exited) {
    finish(1, 'the server exited before it answered');
    break;
  }
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/health`);
    const body = await response.json().catch(() => ({}));
    if (response.ok && body.status === 'ok') {
      if (body.database === expectedDialect) {
        finish(0, `healthy on ${body.database} (WAYMARK_DB_DIALECT=${configured})`);
      } else {
        finish(1, `healthy, but on ${body.database} and not ${expectedDialect}`);
      }
      break;
    }
  } catch {
    // Not up yet.
  }
  await new Promise((resolve) => setTimeout(resolve, 500));
}
if (!exited && Date.now() >= deadline) finish(1, 'the server did not answer in time');
