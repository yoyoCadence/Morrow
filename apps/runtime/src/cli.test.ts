import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import net, { type AddressInfo } from 'node:net';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { migrationChecksum } from './db/migrate.js';

const CLI = fileURLToPath(new URL('./cli.js', import.meta.url));

// Nothing listens here. Any command that reached the database would fail with
// a connection error (exit 1) rather than the configuration refusal (exit 2).
const UNREACHABLE_DB = 'postgres://morrow:unusedPassw0rd@127.0.0.1:9/morrow';

interface CliResult {
  readonly status: number | string | null;
  readonly stdout: string;
  readonly stderr: string;
}

function runCli(args: readonly string[], env: Record<string, string>): Promise<CliResult> {
  // Start from an almost empty environment so the developer's own MORROW_*
  // settings cannot leak into the child.
  const baseline: Record<string, string> = {};
  for (const name of ['PATH', 'Path', 'SystemRoot', 'TEMP', 'TMP']) {
    const value = process.env[name];
    if (value !== undefined) baseline[name] = value;
  }
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], { env: { ...baseline, ...env }, timeout: 120_000 }, (error, stdout, stderr) => {
      resolve({ status: error ? (error.code ?? null) : 0, stdout, stderr });
    });
  });
}

test('starting the API or worker in a live mode is refused before anything else happens', async () => {
  const cases = ['SHADOW', 'LIVE_CANARY', 'EXIT_ONLY', 'GUARDED_AUTO', 'FULL_AUTO'].flatMap((mode) =>
    ['api', 'worker'].map((command) => ({ mode, command })),
  );
  const results = await Promise.all(
    cases.map(({ mode, command }) => runCli([command], { MORROW_MODE: mode, MORROW_DATABASE_URL: UNREACHABLE_DB })),
  );
  results.forEach((result, index) => {
    const { mode, command } = cases[index] ?? { mode: '?', command: '?' };
    assert.equal(result.status, 2, `${command} ${mode}: ${result.stderr}`);
    assert.match(result.stderr, new RegExp(`Mode "${mode}" is not enabled`));
    assert.equal(result.stdout, '', `${command} ${mode}: nothing was started`);
  });
});

test('other commands refuse a live mode as well', async () => {
  const commands = ['migrate', 'probe', 'status', 'stop'];
  const results = await Promise.all(
    commands.map((command) => runCli([command], { MORROW_MODE: 'LIVE_CANARY', MORROW_DATABASE_URL: UNREACHABLE_DB })),
  );
  results.forEach((result, index) => {
    assert.equal(result.status, 2, commands[index]);
    assert.match(result.stderr, /is not enabled/);
  });
});

test('an unrecognised setting stops startup without printing its value', async () => {
  const result = await runCli(['worker'], {
    MORROW_DATABASE_URL: UNREACHABLE_DB,
    MORROW_WALLET_PRIVATE_KEY: 'value-that-must-not-be-printed',
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /MORROW_WALLET_PRIVATE_KEY/);
  assert.doesNotMatch(result.stderr + result.stdout, /value-that-must-not-be-printed/);
});

test('missing configuration is reported by name', async () => {
  const result = await runCli(['migrate'], {});
  assert.equal(result.status, 2);
  assert.match(result.stderr, /MORROW_DATABASE_URL: required but not set/);
});

test('an unreachable database is reported plainly, without a stack trace or the password', async () => {
  const [migrate, worker] = await Promise.all([
    runCli(['migrate'], { MORROW_DATABASE_URL: UNREACHABLE_DB }),
    runCli(['worker'], { MORROW_DATABASE_URL: UNREACHABLE_DB }),
  ]);
  for (const result of [migrate, worker]) {
    assert.equal(result?.status, 1);
    assert.match(result?.stderr ?? '', /Cannot reach the database \(ECONNREFUSED\)/);
    assert.doesNotMatch(result?.stderr ?? '', /unusedPassw0rd|\n\s+at /);
  }
});

test('a database that accepts connections but never answers is reported, not waited on forever', async (t) => {
  const sockets: net.Socket[] = [];
  const silent = net.createServer((socket) => void sockets.push(socket));
  await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    for (const socket of sockets) socket.destroy();
    silent.close();
  });
  const url = `postgres://morrow:unusedPassw0rd@127.0.0.1:${(silent.address() as AddressInfo).port}/morrow`;

  const [migrate, status] = await Promise.all([
    runCli(['migrate'], { MORROW_DATABASE_URL: url }),
    runCli(['status'], { MORROW_DATABASE_URL: url }),
  ]);
  assert.equal(migrate.status, 1);
  assert.match(migrate.stderr, /Cannot reach the database \(connection timed out\)/);
  assert.doesNotMatch(migrate.stderr, /unusedPassw0rd|\n\s+at /);

  assert.equal(status.status, 1);
  const report = JSON.parse(status.stdout) as { status: string; database: { problem: string } };
  assert.equal(report.status, 'critical');
  assert.equal(report.database.problem, 'database unreachable (connection timed out)');
});

test('probe does nothing in OFF mode', async () => {
  const result = await runCli(['probe'], { MORROW_DATABASE_URL: UNREACHABLE_DB });
  assert.equal(result.status, 2);
  assert.match(result.stdout, /MORROW_MODE is OFF/);
});

test('usage is shown for no command and for an unknown one', async () => {
  const [none, unknown, help] = await Promise.all([runCli([], {}), runCli(['trade'], {}), runCli(['help'], {})]);
  assert.equal(none?.status, 2);
  assert.match(none?.stdout ?? '', /Usage: morrow <command>/);
  assert.equal(unknown?.status, 2);
  assert.match(unknown?.stdout ?? '', /Unknown command "trade"/);
  assert.equal(help?.status, 0);
});

test('migration checksums ignore line-ending differences only', () => {
  assert.equal(migrationChecksum('CREATE TABLE a ();\r\nSELECT 1;\r\n'), migrationChecksum('CREATE TABLE a ();\nSELECT 1;\n'));
  assert.notEqual(migrationChecksum('CREATE TABLE a ();\n'), migrationChecksum('CREATE TABLE b ();\n'));
  assert.notEqual(migrationChecksum('SELECT 1;\n'), migrationChecksum('SELECT 1; \n'), 'other whitespace still counts');
});
