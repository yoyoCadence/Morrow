import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import type { AppConfig } from '../config/config.js';
import { createPool } from '../db/pool.js';
import { createRedactor } from '../logging/redact.js';
import { createTestDb, defer, type TestDb } from '../test-support/db.js';
import { type DoctorCheck, formatDoctor, runDoctor } from './doctor.js';

function testDbUrl(): string {
  const url = process.env.MORROW_TEST_DATABASE_URL;
  if (!url) throw new Error('MORROW_TEST_DATABASE_URL is not set');
  return url;
}

function config(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    mode: 'RESEARCH',
    databaseUrl: testDbUrl(),
    apiPort: 8787,
    logLevel: 'silent',
    credentials: {},
    secretValues: [],
    ...overrides,
  };
}

async function freshDb(t: TestContext, migrated = true): Promise<TestDb> {
  const db = await createTestDb({ migrate: migrated });
  defer(t, () => db.close());
  return db;
}

const byName = (checks: readonly DoctorCheck[], name: string): DoctorCheck | undefined => checks.find((check) => check.name === name);

test('a migrated database: reachable, migrations current, clock skew not yet known, hosts not checked', async (t) => {
  const db = await freshDb(t);
  const checks = await runDoctor({ config: config(), pool: db.pool, redact: (text) => text, network: false });

  assert.match(byName(checks, 'Database')?.detail ?? '', /^PostgreSQL \d+/);
  const migrations = byName(checks, 'Migrations');
  assert.equal(migrations?.status, 'ok');
  assert.match(migrations?.detail ?? '', /^\d+ applied, none pending$/);
  assert.equal(byName(checks, 'Clock skew')?.status, 'info', 'no provider responses yet: unknown, not zero');
  assert.equal(byName(checks, 'Provider hosts')?.status, 'skip');
  assert.equal(byName(checks, 'Mode')?.detail, 'RESEARCH, API on 127.0.0.1:8787');
});

test('pending migrations fail the check and skip what needs the schema', async (t) => {
  const db = await freshDb(t, false);
  const checks = await runDoctor({ config: config(), pool: db.pool, redact: (text) => text, network: false });
  const migrations = byName(checks, 'Migrations');
  assert.equal(migrations?.status, 'fail');
  assert.match(migrations?.detail ?? '', /^0 applied, \d+ pending: run npm run migrate$/);
  assert.equal(byName(checks, 'Clock skew')?.status, 'skip');
});

test('an unreachable database fails without printing its password, and the rest of the checks still run', async (t) => {
  const password = 'doctor-db-passw0rd';
  const url = `postgres://morrow:${password}@127.0.0.1:9/morrow`;
  const pool = createPool(url, { applicationName: 'doctor-test', connectionTimeoutMs: 2_000 });
  defer(t, () => pool.end());
  const checks = await runDoctor({
    config: config({ databaseUrl: url, secretValues: [password] }),
    pool,
    redact: createRedactor([password]),
    network: false,
  });

  assert.equal(byName(checks, 'Database')?.status, 'fail');
  assert.equal(byName(checks, 'Migrations')?.status, 'skip');
  assert.equal(byName(checks, 'Restore check database')?.status, 'warn');
  assert.ok(byName(checks, 'Credentials: okx'), 'the checks that need no database still ran');
  assert.ok(!formatDoctor(checks).includes(password), 'the password was printed');
});

test('with --network every provider host is checked, and one that does not resolve fails', async (t) => {
  const db = await freshDb(t);
  const checks = await runDoctor({
    config: config(),
    pool: db.pool,
    redact: (text) => text,
    network: true,
    hosts: ['a.example', 'b.example'],
    hostOptions: {
      lookup: async (host) => {
        throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: 'ENOTFOUND' });
      },
    },
  });
  assert.deepEqual(
    checks.filter((check) => check.name.startsWith('Host ')).map((check) => [check.name, check.status, check.detail]),
    [
      ['Host a.example', 'fail', 'DNS_FAILED (ENOTFOUND): the name does not resolve'],
      ['Host b.example', 'fail', 'DNS_FAILED (ENOTFOUND): the name does not resolve'],
    ],
  );
  assert.equal(byName(checks, 'Provider hosts'), undefined);
});
