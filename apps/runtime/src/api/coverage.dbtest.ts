import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CoverageReport } from '@morrow/core';
import { createPool } from '../db/pool.js';
import { createTestDb, defer, silentLogger } from '../test-support/db.js';
import { buildCoverage } from './coverage.js';
import { buildApiServer } from './server.js';

test('coverage reads worker sessions and gaps from the database, relative to its clock', async (t) => {
  const db = await createTestDb();
  defer(t, () => db.close());
  const insertSession = (mode: string, status: string, start: string, heartbeat: string, end: string | null) =>
    db.pool.query(
      `INSERT INTO run_sessions (component, mode, status, started_at, last_heartbeat_at, ended_at, host, pid, app_version)
       VALUES ('worker', $1, $2, clock_timestamp() - $3::interval, clock_timestamp() - $4::interval,
               clock_timestamp() - $5::interval, 'test-host', 1, 'test')
       RETURNING id`,
      [mode, status, start, heartbeat, end],
    );
  // 30 h ago to 20 h ago: observed, then stopped cleanly; offline until 12 h ago.
  const first = await insertSession('RESEARCH', 'STOPPED', '30 hours', '20 hours', '20 hours');
  // 12 h ago until now, still heartbeating, with a 1 h sleep from 6 h to 5 h ago.
  const second = await insertSession('RESEARCH', 'RUNNING', '12 hours', '1 second', null);
  const ids = [first.rows[0]?.id, second.rows[0]?.id];
  await db.pool.query(
    `INSERT INTO session_gaps (component, kind, gap_start, gap_end, previous_session_id, detected_by_session_id) VALUES
       ('worker', 'OFFLINE', clock_timestamp() - interval '20 hours', clock_timestamp() - interval '12 hours', $1, $2),
       ('worker', 'HEARTBEAT_STALL', clock_timestamp() - interval '6 hours', clock_timestamp() - interval '5 hours', $2, $2)`,
    ids,
  );

  const report = CoverageReport.parse(await buildCoverage(db.pool, 24));
  assert.equal(report.window_ms, 24 * 3_600_000);
  assert.deepEqual(
    report.segments.map((segment) => segment.reason ?? 'OBSERVING'),
    ['OBSERVING', 'OFFLINE', 'OBSERVING', 'HEARTBEAT_STALL', 'OBSERVING'],
  );
  // 4 h (24 h ago to 20 h ago) + 11 h (12 h ago to now, minus the 1 h stall), to within a second of query time.
  assert.ok(Math.abs(report.observed_ms - 15 * 3_600_000) < 5_000, String(report.observed_ms));
  assert.equal(report.segments[0]?.start, report.from);
  assert.equal(report.segments.at(-1)?.end, report.to);
});

test('the coverage endpoint accepts the day and the week, and nothing else', async (t) => {
  const db = await createTestDb();
  defer(t, () => db.close());
  const port = 8787;
  const app = await buildApiServer({ pool: db.pool, logger: silentLogger, mode: 'RESEARCH', version: 'test', port });
  defer(t, () => app.close());
  const headers = { host: `127.0.0.1:${port}` };

  for (const hours of [24, 168]) {
    const reply = await app.inject({ url: `/api/coverage?hours=${hours}`, headers });
    assert.equal(reply.statusCode, 200);
    const report = CoverageReport.parse(reply.json());
    assert.equal(report.window_ms, hours * 3_600_000);
    assert.deepEqual(report.segments.map((segment) => segment.reason), ['NO_RECORD'], 'no worker has ever run');
  }
  assert.equal((await app.inject({ url: '/api/coverage', headers })).statusCode, 200, 'the day is the default');
  for (const bad of ['5', 'abc', '24&hours=168']) {
    assert.equal((await app.inject({ url: `/api/coverage?hours=${bad}`, headers })).statusCode, 400, bad);
  }
});

test('without a database the endpoint says so, without passing the error to the page', async (t) => {
  const dead = createPool('postgres://nobody@127.0.0.1:1/nothing', { applicationName: 'morrow-test', connectionTimeoutMs: 2_000 });
  defer(t, () => dead.end());
  const port = 8787;
  const app = await buildApiServer({ pool: dead, logger: silentLogger, mode: 'RESEARCH', version: 'test', port });
  defer(t, () => app.close());
  const reply = await app.inject({ url: '/api/coverage?hours=24', headers: { host: `127.0.0.1:${port}` } });
  assert.deepEqual([reply.statusCode, reply.json()], [503, { error: 'COVERAGE_UNAVAILABLE' }]);
});
