import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createTestDb, type TestDb } from '../test-support/db.js';
import { createPool, isQueryReadTimeout, withTransaction } from './pool.js';

const PG_QUERY_CANCELED = '57014';

let db: TestDb;

before(async () => {
  db = await createTestDb({ migrate: false });
});

after(async () => {
  await db.close();
});

function poolWith(options: { statementTimeoutMs?: number; queryTimeoutMs?: number }) {
  const pool = createPool(db.url, { applicationName: 'morrow-test', schema: db.schema, ...options });
  after(() => pool.end());
  return pool;
}

async function setting(pool: ReturnType<typeof createPool>, name: string): Promise<string | undefined> {
  return (await pool.query<{ value: string }>('SELECT current_setting($1) AS value', [name])).rows[0]?.value;
}

test('every connection has a statement timeout and an idle-in-transaction timeout by default', async () => {
  assert.equal(await setting(db.pool, 'statement_timeout'), '30s');
  assert.equal(await setting(db.pool, 'idle_in_transaction_session_timeout'), '1min');
  assert.equal(await setting(db.pool, 'TimeZone'), 'UTC');
});

test('a statement that runs past its timeout is cancelled by the server', async () => {
  const pool = poolWith({ statementTimeoutMs: 200 });
  const started = Date.now();
  await assert.rejects(pool.query('SELECT pg_sleep(5)'), (error: { code?: string }) => error.code === PG_QUERY_CANCELED);
  assert.ok(Date.now() - started < 2_000);
  assert.equal((await pool.query<{ one: number }>('SELECT 1 AS one')).rows[0]?.one, 1, 'the pool still works');
});

test('migrations can turn the statement timeout off', async () => {
  const pool = poolWith({ statementTimeoutMs: 0 });
  assert.equal(await setting(pool, 'statement_timeout'), '0');
});

test('an answer that never comes ends the query, and that connection is not reused', async () => {
  // The server would let it run for 30 s; this process stops waiting after 200 ms.
  const pool = poolWith({ statementTimeoutMs: 30_000, queryTimeoutMs: 200 });
  const started = Date.now();
  await assert.rejects(
    withTransaction(pool, (tx) => tx.query('SELECT pg_sleep(3)')),
    (error) => isQueryReadTimeout(error),
  );
  assert.ok(Date.now() - started < 2_000);
  assert.equal(pool.totalCount, 0, 'a connection in an unknown state is destroyed, not returned to the pool');

  const result = await withTransaction(pool, (tx) => tx.query<{ one: number }>('SELECT 1 AS one'));
  assert.equal(result.rows[0]?.one, 1, 'the next caller gets a fresh connection');
});
