import assert from 'node:assert/strict';
import { test } from 'node:test';
import { enqueueJob } from '../jobs/job-queue.js';
import { createTestDb, defer } from '../test-support/db.js';
import { measureStorage, STORAGE_TIME_COLUMNS } from './storage.js';

test('every table is classified for storage measurement, by a column that exists', async (t) => {
  const db = await createTestDb();
  defer(t, () => db.close());
  const tables = await db.pool.query<{ table_name: string }>(
    "SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() AND table_type = 'BASE TABLE' ORDER BY 1",
  );
  // A new table must be added to STORAGE_TIME_COLUMNS, with its time column or null.
  assert.deepEqual(
    tables.rows.map((row) => row.table_name),
    Object.keys(STORAGE_TIME_COLUMNS).sort(),
  );
  for (const [table, column] of Object.entries(STORAGE_TIME_COLUMNS)) {
    if (column === null) continue;
    const found = await db.pool.query(
      "SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1 AND column_name = $2 AND data_type = 'timestamp with time zone'",
      [table, column],
    );
    assert.equal(found.rowCount, 1, `${table}.${column} is a timestamptz column`);
  }
});

test('storage counts rows and the last day of growth, and says when growth is unknown', async (t) => {
  const db = await createTestDb();
  defer(t, () => db.close());
  for (let n = 0; n < 3; n += 1) await enqueueJob(db.pool, { kind: 'test.work', payload: { n } });
  await db.pool.query("UPDATE jobs SET created_at = clock_timestamp() - interval '2 days' WHERE payload->>'n' = '0'");
  await db.pool.query(
    "INSERT INTO source_health (provider, capability, state, last_outcome) VALUES ('dexscreener', 'market.tokens', 'HEALTHY', 'OK')",
  );

  const report = await measureStorage(db.pool);
  const jobs = report.tables.find((table) => table.table === 'jobs');
  assert.equal(jobs?.rows, 3);
  assert.equal(jobs?.rowsLastDay, 2, 'the job created two days ago is not part of the last day');
  assert.ok((jobs?.totalBytes ?? 0) > 0);
  assert.equal(jobs?.bytesLastDay, Math.round(((jobs?.totalBytes ?? 0) * 2) / 3));

  const health = report.tables.find((table) => table.table === 'source_health');
  assert.deepEqual([health?.rows, health?.rowsLastDay, health?.bytesLastDay], [1, null, null], 'no time column: unknown, not zero');

  const empty = report.tables.find((table) => table.table === 'events');
  assert.deepEqual([empty?.rows, empty?.rowsLastDay, empty?.bytesLastDay], [0, 0, 0]);

  assert.equal(report.tables.length, Object.keys(STORAGE_TIME_COLUMNS).length);
  const sizes = report.tables.map((table) => table.totalBytes);
  assert.deepEqual(sizes, [...sizes].sort((a, b) => b - a), 'largest first');
  assert.ok(report.databaseBytes > 0);
  const known = report.tables.reduce((sum, table) => sum + (table.bytesLastDay ?? 0), 0);
  assert.equal(report.bytesLastDay, known);
});
