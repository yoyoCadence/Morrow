import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { createTestDb, type TestDb } from '../test-support/db.js';
import { getMigrationStatus, loadMigrations, migrate, MigrationError } from './migrate.js';

async function emptyDb(t: TestContext): Promise<TestDb> {
  const db = await createTestDb({ migrate: false });
  t.after(() => db.close());
  return db;
}

async function migrationsDir(t: TestContext, files: Record<string, string>): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'morrow-migrations-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const [name, sql] of Object.entries(files)) await writeFile(path.join(directory, name), sql);
  return directory;
}

async function tableExists(db: TestDb, table: string): Promise<boolean> {
  const result = await db.pool.query<{ present: boolean }>('SELECT to_regclass($1) IS NOT NULL AS present', [table]);
  return result.rows[0]?.present === true;
}

test('an empty database migrates to the current schema, and a second run changes nothing', async (t) => {
  const db = await emptyDb(t);
  const files = await loadMigrations();
  assert.ok(files.length >= 1);
  assert.deepEqual(await getMigrationStatus(db.pool), { applied: 0, pending: files.length });

  const first = await migrate(db.pool);
  assert.equal(first.applied.length, files.length);
  assert.equal(first.alreadyApplied, 0);

  for (const table of [
    'run_sessions', 'session_gaps', 'raw_payloads', 'raw_observations', 'events', 'jobs', 'consumer_inbox',
    'quota_counters', 'quota_events', 'source_health', 'provider_probes', 'audit_log',
  ]) {
    assert.equal(await tableExists(db, table), true, table);
  }

  const second = await migrate(db.pool);
  assert.deepEqual({ applied: second.applied.length, already: second.alreadyApplied }, { applied: 0, already: files.length });
  assert.deepEqual(await getMigrationStatus(db.pool), { applied: files.length, pending: 0 });
});

test('editing a migration after it was applied is detected', async (t) => {
  const db = await emptyDb(t);
  const directory = await migrationsDir(t, { '0001_first.sql': 'CREATE TABLE first_table (id integer);\n' });
  await migrate(db.pool, directory);

  await writeFile(path.join(directory, '0001_first.sql'), 'CREATE TABLE first_table (id bigint);\n');
  await assert.rejects(migrate(db.pool, directory), (error: unknown) => {
    assert.ok(error instanceof MigrationError);
    assert.match(error.message, /changed after it was applied/);
    return true;
  });
  await assert.rejects(getMigrationStatus(db.pool, directory), MigrationError);
});

test('a checkout with different line endings is still the same migration', async (t) => {
  const db = await emptyDb(t);
  const directory = await migrationsDir(t, { '0001_first.sql': 'CREATE TABLE first_table (id integer);\nSELECT 1;\n' });
  await migrate(db.pool, directory);

  await writeFile(path.join(directory, '0001_first.sql'), 'CREATE TABLE first_table (id integer);\r\nSELECT 1;\r\n');
  assert.deepEqual(await getMigrationStatus(db.pool, directory), { applied: 1, pending: 0 });
});

test('a database that is ahead of the code is refused', async (t) => {
  const db = await emptyDb(t);
  const newer = await migrationsDir(t, {
    '0001_first.sql': 'CREATE TABLE first_table (id integer);\n',
    '0002_second.sql': 'CREATE TABLE second_table (id integer);\n',
  });
  await migrate(db.pool, newer);

  const older = await migrationsDir(t, { '0001_first.sql': 'CREATE TABLE first_table (id integer);\n' });
  await assert.rejects(migrate(db.pool, older), /does not know/);
});

test('a failing migration rolls back completely and keeps earlier ones', async (t) => {
  const db = await emptyDb(t);
  const directory = await migrationsDir(t, {
    '0001_first.sql': 'CREATE TABLE first_table (id integer);\n',
    '0002_broken.sql': 'CREATE TABLE half_done (id integer);\nSELECT * FROM table_that_does_not_exist;\n',
  });

  await assert.rejects(migrate(db.pool, directory), (error: unknown) => {
    assert.ok(error instanceof MigrationError);
    assert.match(error.message, /Migration 2 \(broken\) failed and was rolled back/);
    return true;
  });
  assert.equal(await tableExists(db, 'first_table'), true, 'the earlier migration stays applied');
  assert.equal(await tableExists(db, 'half_done'), false, 'nothing from the failed migration remains');
  assert.deepEqual(await getMigrationStatus(db.pool, directory), { applied: 1, pending: 1 });

  await writeFile(path.join(directory, '0002_broken.sql'), 'CREATE TABLE half_done (id integer);\n');
  const retry = await migrate(db.pool, directory);
  assert.equal(retry.applied.length, 1);
  assert.equal(await tableExists(db, 'half_done'), true);
});

test('migration files must be well named and numbered without gaps', async (t) => {
  const gap = await migrationsDir(t, { '0001_a.sql': 'SELECT 1;', '0003_c.sql': 'SELECT 1;' });
  await assert.rejects(loadMigrations(gap), /contiguous/);
  const badName = await migrationsDir(t, { 'init.sql': 'SELECT 1;' });
  await assert.rejects(loadMigrations(badName), /NNNN_description\.sql/);
});

test('two migrate runs at the same time apply each migration once', async (t) => {
  const db = await emptyDb(t);
  const files = await loadMigrations();
  const results = await Promise.all([migrate(db.pool), migrate(db.pool), migrate(db.pool)]);
  assert.equal(
    results.reduce((total, result) => total + result.applied.length, 0),
    files.length,
  );
  const rows = await db.pool.query('SELECT version FROM schema_migrations');
  assert.equal(rows.rowCount, files.length);
});
