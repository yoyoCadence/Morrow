import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { type TestContext, test } from 'node:test';
import { createTestDb, defer, type TestDb } from '../test-support/db.js';
import { assertRestoreCheckPossible, type BackupManifest, checkRestore, createBackup } from './backup.js';
import { createPool } from './pool.js';

const identity = (text: string) => text;

/** A migrated test schema with a few rows, a backup folder, and a pool on the restore check database. */
async function setup(t: TestContext) {
  const db: TestDb = await createTestDb();
  defer(t, () => db.close());
  const dir = await mkdtemp(path.join(os.tmpdir(), 'morrow-backup-'));
  defer(t, () => rm(dir, { recursive: true, force: true }));
  const checkUrl = new URL(db.url);
  checkUrl.pathname = `${checkUrl.pathname}_restore_check`;
  const check = createPool(checkUrl.toString(), { applicationName: 'morrow-test' });
  defer(t, () => check.end());
  defer(t, () => check.query(`DROP SCHEMA IF EXISTS ${db.schema} CASCADE`));

  const session = await db.pool.query<{ id: string }>(
    "INSERT INTO run_sessions (component, mode, host, pid, app_version) VALUES ('worker', 'RESEARCH', 'h', 1, 't') RETURNING id",
  );
  await db.pool.query(
    `INSERT INTO session_gaps (component, kind, gap_start, gap_end, detected_by_session_id)
     VALUES ('worker', 'OFFLINE', now() - interval '1 hour', now(), $1)`,
    [session.rows[0]?.id],
  );
  await db.pool.query("INSERT INTO quota_counters (provider, bucket, period_start, used) VALUES ('okx', 'basic', '2026-10-01', 24650)");
  return { db, dir, check };
}

const schemaExists = async (check: { query: (sql: string, values: unknown[]) => Promise<{ rowCount: number | null }> }, schema: string) =>
  ((await check.query('SELECT 1 FROM pg_namespace WHERE nspname = $1', [schema])).rowCount ?? 0) > 0;

test('a backup restores into the check database and matches its manifest, table by table', async (t) => {
  const { db, dir, check } = await setup(t);
  const backup = await createBackup({ pool: db.pool, connectionString: db.url, schema: db.schema, dir, redact: identity });

  assert.deepEqual(
    (await readdir(dir)).sort(),
    [path.basename(backup.file), path.basename(backup.manifestFile)].sort(),
    'the dump and its manifest, and no partial file',
  );
  const { manifest } = backup;
  assert.equal(manifest.schema, db.schema);
  assert.equal(manifest.tables['run_sessions'], 1);
  assert.equal(manifest.tables['session_gaps'], 1);
  assert.equal(manifest.tables['quota_counters'], 1);
  const applied = await db.pool.query<{ n: number }>('SELECT count(*)::int AS n FROM schema_migrations');
  assert.equal(manifest.migrations.length, applied.rows[0]?.n, 'every applied migration');
  assert.ok(manifest.migrations.length >= 6);
  assert.ok(manifest.triggers.includes('schedule_gaps_append_only'), 'the append-only guards are part of the backup');
  assert.equal(JSON.parse(await readFile(backup.manifestFile, 'utf8')).sha256, manifest.sha256);

  const restored = await checkRestore({ connectionString: db.url, manifestFile: backup.manifestFile, redact: identity });
  assert.equal(restored.database, `${new URL(db.url).pathname.slice(1)}_restore_check`);
  assert.equal(restored.tables, Object.keys(manifest.tables).length);
  assert.equal(await schemaExists(check, db.schema), false, 'a passing check cleans up after itself');
  const recorded = JSON.parse(await readFile(backup.manifestFile, 'utf8')) as BackupManifest;
  assert.equal(recorded.restore_check?.database, restored.database, 'the manifest says this backup was restored');
  assert.equal((await db.pool.query('SELECT 1 FROM run_sessions')).rowCount, 1, 'the source is untouched');
});

test('the public schema, which is what npm run backup dumps, restores and checks too', async (t) => {
  const { db, dir, check } = await setup(t);
  // The test database's public schema is otherwise unused: test files work in their own schemas.
  const table = `backup_public_${db.schema}`;
  await db.pool.query(`CREATE TABLE public.${table} (id int)`);
  defer(t, () => db.pool.query(`DROP TABLE IF EXISTS public.${table}`));
  await db.pool.query(`INSERT INTO public.${table} VALUES (1), (2), (3)`);

  const backup = await createBackup({ pool: db.pool, connectionString: db.url, schema: 'public', dir, redact: identity });
  assert.equal(backup.manifest.tables[table], 3);
  await checkRestore({ connectionString: db.url, manifestFile: backup.manifestFile, redact: identity });
  assert.equal(await schemaExists(check, 'public'), false, 'cleaned up after the check');

  // Again, now that the check database has no public schema at all.
  const again = await createBackup({ pool: db.pool, connectionString: db.url, schema: 'public', dir, redact: identity });
  await checkRestore({ connectionString: db.url, manifestFile: again.manifestFile, redact: identity });
});

test('the dump and its row counts come from one snapshot while writes continue', async (t) => {
  const { db, dir } = await setup(t);
  let writing = true;
  const writer = (async () => {
    while (writing) await db.pool.query("INSERT INTO audit_log (actor, action) VALUES ('test', 'concurrent.write')");
  })();
  try {
    const backup = await createBackup({ pool: db.pool, connectionString: db.url, schema: db.schema, dir, redact: identity });
    await checkRestore({ connectionString: db.url, manifestFile: backup.manifestFile, redact: identity });
  } finally {
    writing = false;
    await writer;
  }
});

test('a damaged backup is refused before anything is restored', async (t) => {
  const { db, dir, check } = await setup(t);
  const backup = await createBackup({ pool: db.pool, connectionString: db.url, schema: db.schema, dir, redact: identity });
  const bytes = await readFile(backup.file);
  bytes[bytes.length - 10] = (bytes[bytes.length - 10] ?? 0) ^ 0xff;
  await writeFile(backup.file, bytes);

  await assert.rejects(checkRestore({ connectionString: db.url, manifestFile: backup.manifestFile, redact: identity }), /does not match its manifest/);
  assert.equal(await schemaExists(check, db.schema), false);
});

test('a restored copy that differs from the manifest is reported, and kept for inspection', async (t) => {
  const { db, dir, check } = await setup(t);
  const backup = await createBackup({ pool: db.pool, connectionString: db.url, schema: db.schema, dir, redact: identity });
  const manifest = JSON.parse(await readFile(backup.manifestFile, 'utf8')) as BackupManifest;
  await writeFile(backup.manifestFile, JSON.stringify({ ...manifest, tables: { ...manifest.tables, run_sessions: 2 } }));

  await assert.rejects(
    checkRestore({ connectionString: db.url, manifestFile: backup.manifestFile, redact: identity }),
    /run_sessions: 2 rows in the backup's manifest, 1 restored/,
  );
  assert.equal(await schemaExists(check, db.schema), true);
  const recorded = JSON.parse(await readFile(backup.manifestFile, 'utf8')) as BackupManifest;
  assert.equal(recorded.restore_check, undefined, 'a failed check is not recorded as passed');
});

test('a missing restore check database is reported before anything is dumped', async (t) => {
  const { db } = await setup(t);
  const elsewhere = new URL(db.url);
  elsewhere.pathname = '/morrow_no_such_database';
  await assert.rejects(assertRestoreCheckPossible(elsewhere.toString()), /"morrow_no_such_database_restore_check" does not exist/);
  await assert.doesNotReject(assertRestoreCheckPossible(db.url));
});
