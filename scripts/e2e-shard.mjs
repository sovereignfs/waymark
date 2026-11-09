// The browser tests, split into shards that run at once, each on instances, databases and ports of its own. Two ways to use it:
//
//   node scripts/e2e-shard.mjs --shard 2/6 [playwright args]   one shard, for a job of CI's matrix
//   node scripts/e2e-shard.mjs --all [--shards 4] [playwright args]   every shard on this machine, at once (`pnpm e2e:fast`)
//
// A shard is a set of spec FILES, and runs both browsers over them, Chromium first: some specs hand work from one browser to the other (the key one saves in the
// first what the second opens), so a file is never split across shards. The files are shared out by how many tests they hold, biggest first, the same on every
// machine. Shards use the file form of the database whatever the environment names, since they cannot share one database: the tests that share an account would
// meet each other's changes; the other forms have the data-layer tests, and a small run of these on each (`pnpm e2e --project=chromium <specs>` in CI).
// Run `pnpm build` first.
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { cpus } from 'node:os';
import { resolve } from 'node:path';
import { prepareStandalone } from './lib/standalone.mjs';

const root = resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const flag = (name) => {
  const at = args.indexOf(name);
  return at < 0 ? undefined : args[at + 1];
};
const consumed = new Set();
for (const name of ['--shard', '--shards']) {
  const at = args.indexOf(name);
  if (at >= 0) {
    consumed.add(at);
    consumed.add(at + 1);
  }
}
const all = args.includes('--all');
if (all) consumed.add(args.indexOf('--all'));
const passed = args.filter((_, at) => !consumed.has(at));

/** The environment without what names a database or a directory for a run: a shard makes its own. */
function cleanEnv() {
  const { WAYMARK_DB_DIALECT: _dialect, WAYMARK_E2E_DIR: _directory, ...rest } = process.env;
  return rest;
}

/** The spec files with how many tests each holds, from Playwright itself. */
function specs() {
  const run = spawnSync('pnpm', ['exec', 'playwright', 'test', '--list', '--reporter=json'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: cleanEnv(),
  });
  if (run.status !== 0) throw new Error(`could not list the tests: ${run.stderr || run.stdout}`);
  const counts = new Map();
  const count = (suite, file) => {
    const here = suite.file ?? file;
    for (const spec of suite.specs ?? [])
      counts.set(here, (counts.get(here) ?? 0) + spec.tests.length);
    for (const child of suite.suites ?? []) count(child, here);
  };
  for (const suite of JSON.parse(run.stdout).suites) count(suite, suite.file);
  return [...counts].map(([file, tests]) => ({ file: `e2e/${file}`, tests }));
}

/** Biggest first, each to the shard with the fewest so far, and the same answer every time. */
export function shardsOf(files, n) {
  const sorted = [...files].sort((a, b) => b.tests - a.tests || (a.file < b.file ? -1 : 1));
  const shards = Array.from({ length: n }, () => ({ files: [], tests: 0 }));
  for (const each of sorted) {
    const lightest = shards.reduce((a, b) => (b.tests < a.tests ? b : a));
    lightest.files.push(each.file);
    lightest.tests += each.tests;
  }
  return shards;
}

function run(index, files, prefix) {
  const offset = (index - 1) * 100;
  const env = {
    ...cleanEnv(),
    // The file form, in a directory of this shard's own (the config makes it), and ports of its own.
    WAYMARK_E2E_PORT_OFFSET: String(offset),
    WAYMARK_STANDALONE_READY: '1',
    PLAYWRIGHT_HTML_REPORT: resolve(root, `playwright-report/shard-${index}`),
  };
  const child = spawn(
    'pnpm',
    ['exec', 'playwright', 'test', `--output=test-results/shard-${index}`, ...passed, ...files],
    { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const forward = (stream, sink) => {
    let rest = '';
    stream.on('data', (chunk) => {
      const lines = (rest + chunk).split('\n');
      rest = lines.pop() ?? '';
      for (const line of lines) if (line.trim() !== '') sink.write(`${prefix}${line}\n`);
    });
  };
  forward(child.stdout, process.stdout);
  forward(child.stderr, process.stderr);
  return new Promise((done) => child.on('exit', (code) => done(code ?? 1)));
}

const listed = specs();
if (all) {
  const n = Number(flag('--shards') ?? Math.max(2, Math.min(6, Math.floor(cpus().length / 2))));
  const shards = shardsOf(listed, n);
  prepareStandalone();
  mkdirSync(resolve(root, 'test-results'), { recursive: true });
  console.log(
    `${listed.reduce((sum, each) => sum + each.tests, 0)} tests in ${n} shards: ${shards.map((each) => each.tests).join(', ')}`,
  );
  const started = Date.now();
  const codes = await Promise.all(
    shards.map((each, at) => run(at + 1, each.files, `[${at + 1}/${n}] `)),
  );
  const failed = codes.flatMap((code, at) => (code === 0 ? [] : [at + 1]));
  console.log(
    `${Math.round((Date.now() - started) / 1000)} s; ${failed.length === 0 ? 'every shard passed' : `shards that failed: ${failed.join(', ')}`}`,
  );
  process.exit(failed.length === 0 ? 0 : 1);
} else {
  const [index, total] = (flag('--shard') ?? '').split('/').map(Number);
  if (!Number.isInteger(index) || !Number.isInteger(total) || index < 1 || index > total) {
    console.error(
      'usage: node scripts/e2e-shard.mjs --shard <i>/<n> | --all [--shards <n>]  [playwright args]',
    );
    process.exit(2);
  }
  const files = shardsOf(listed, total)[index - 1].files;
  console.log(`shard ${index}/${total}: ${files.length} files`);
  prepareStandalone();
  process.exit(await run(index, files, ''));
}
