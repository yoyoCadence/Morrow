import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { createTestDb, type TestDb } from '../test-support/db.js';
import { heartbeat, requestStop, SessionConflictError, startSession, stopSession, type StartSessionInput } from './run-session.js';

async function freshDb(t: TestContext): Promise<TestDb> {
  const db = await createTestDb();
  t.after(() => db.close());
  return db;
}

const input = (overrides: Partial<StartSessionInput> = {}): StartSessionInput => ({
  component: 'worker',
  mode: 'RESEARCH',
  appVersion: 'test',
  host: 'test-host',
  pid: 4242,
  isPidAlive: () => true,
  ...overrides,
});

async function sessionRow(db: TestDb, id: string) {
  const result = await db.pool.query<{ status: string; ended_at: Date | null; last_heartbeat_at: Date }>(
    'SELECT status, ended_at, last_heartbeat_at FROM run_sessions WHERE id = $1',
    [id],
  );
  return result.rows[0];
}

async function gaps(db: TestDb) {
  const result = await db.pool.query<{ kind: string; gap_start: Date; gap_end: Date; previous_session_id: string | null }>(
    'SELECT kind, gap_start, gap_end, previous_session_id FROM session_gaps ORDER BY id',
  );
  return result.rows;
}

async function ageHeartbeat(db: TestDb, sessionId: string, seconds: number): Promise<Date> {
  const result = await db.pool.query<{ last_heartbeat_at: Date }>(
    `UPDATE run_sessions SET last_heartbeat_at = clock_timestamp() - make_interval(secs => $2)
      WHERE id = $1 RETURNING last_heartbeat_at`,
    [sessionId, seconds],
  );
  const at = result.rows[0]?.last_heartbeat_at;
  assert.ok(at);
  return at;
}

test('the first start has no gap', async (t) => {
  const db = await freshDb(t);
  const started = await startSession(db.pool, input());
  assert.equal(started.gap, null);
  assert.equal((await sessionRow(db, started.sessionId))?.status, 'RUNNING');
  assert.deepEqual(await gaps(db), []);
});

test('downtime after a clean stop is recorded as an OFFLINE gap', async (t) => {
  const db = await freshDb(t);
  const first = await startSession(db.pool, input());
  assert.equal(await stopSession(db.pool, first.sessionId, 'worker'), true);
  const stoppedAt = (await sessionRow(db, first.sessionId))?.ended_at;
  assert.ok(stoppedAt);

  const second = await startSession(db.pool, input());
  assert.equal(second.gap?.kind, 'OFFLINE');
  assert.equal(second.gap?.start.getTime(), stoppedAt.getTime());
  const recorded = await gaps(db);
  assert.equal(recorded.length, 1);
  assert.deepEqual(
    { kind: recorded[0]?.kind, previous: recorded[0]?.previous_session_id },
    { kind: 'OFFLINE', previous: first.sessionId },
  );
});

test('a session that never stopped is marked ABANDONED and its silence becomes an UNCLEAN_SHUTDOWN gap', async (t) => {
  const db = await freshDb(t);
  const crashed = await startSession(db.pool, input());
  const lastHeartbeat = await ageHeartbeat(db, crashed.sessionId, 600);

  const next = await startSession(db.pool, input({ pid: 5555 }));
  assert.equal(next.gap?.kind, 'UNCLEAN_SHUTDOWN');
  assert.equal(next.gap?.start.getTime(), lastHeartbeat.getTime(), 'the gap starts at the last sign of life');
  assert.ok((next.gap?.end.getTime() ?? 0) - lastHeartbeat.getTime() >= 600_000);

  const previous = await sessionRow(db, crashed.sessionId);
  assert.equal(previous?.status, 'ABANDONED');
  assert.equal(previous?.ended_at?.getTime(), lastHeartbeat.getTime());
  assert.equal((await sessionRow(db, next.sessionId))?.status, 'RUNNING');
});

test('a second process cannot start while the first is alive', async (t) => {
  const db = await freshDb(t);
  const first = await startSession(db.pool, input());
  await assert.rejects(startSession(db.pool, input({ pid: 5555 })), SessionConflictError);
  assert.equal((await sessionRow(db, first.sessionId))?.status, 'RUNNING', 'the live session is untouched');
  assert.deepEqual(await gaps(db), []);

  // The API and the worker are separate components and do not block each other.
  const api = await startSession(db.pool, input({ component: 'api' }));
  assert.equal((await sessionRow(db, api.sessionId))?.status, 'RUNNING');
});

test('a crashed process on this host can be replaced immediately', async (t) => {
  const db = await freshDb(t);
  await startSession(db.pool, input());
  const next = await startSession(db.pool, input({ pid: 5555, isPidAlive: () => false }));
  assert.equal(next.gap?.kind, 'UNCLEAN_SHUTDOWN');
});

test('a recycled pid does not keep a dead session alive forever', async (t) => {
  const db = await freshDb(t);
  const old = await startSession(db.pool, input());
  await ageHeartbeat(db, old.sessionId, 120);
  // Some unrelated process now has the old pid, but there has been no heartbeat.
  const next = await startSession(db.pool, input({ pid: 5555, isPidAlive: () => true }));
  assert.equal(next.gap?.kind, 'UNCLEAN_SHUTDOWN');
});

test('a session on another host is trusted only while it heartbeats', async (t) => {
  const db = await freshDb(t);
  const remote = await startSession(db.pool, input({ host: 'other-host' }));
  await assert.rejects(startSession(db.pool, input({ isPidAlive: () => false })), SessionConflictError);
  await ageHeartbeat(db, remote.sessionId, 120);
  const next = await startSession(db.pool, input());
  assert.equal(next.gap?.kind, 'UNCLEAN_SHUTDOWN');
});

test('two simultaneous starts let exactly one in', async (t) => {
  const db = await freshDb(t);
  const results = await Promise.allSettled([
    startSession(db.pool, input({ pid: 1 })),
    startSession(db.pool, input({ pid: 2 })),
    startSession(db.pool, input({ pid: 3 })),
  ]);
  const started = results.filter((result) => result.status === 'fulfilled');
  const refused = results.filter((result) => result.status === 'rejected');
  assert.equal(started.length, 1);
  assert.equal(refused.length, 2);
  for (const result of refused) assert.ok((result as PromiseRejectedResult).reason instanceof SessionConflictError);
  const running = await db.pool.query("SELECT 1 FROM run_sessions WHERE status = 'RUNNING'");
  assert.equal(running.rowCount, 1);
});

test('a heartbeat keeps the session fresh and reports nothing unusual', async (t) => {
  const db = await freshDb(t);
  const { sessionId } = await startSession(db.pool, input());
  await ageHeartbeat(db, sessionId, 3);
  const result = await heartbeat(db.pool, sessionId, 'worker');
  assert.deepEqual(result, { status: 'ok', stopRequested: false, stall: null });
  const row = await sessionRow(db, sessionId);
  assert.ok(Date.now() - (row?.last_heartbeat_at.getTime() ?? 0) < 2_000);
});

test('a long silence between heartbeats (sleep, hibernate) is recorded as a stall gap', async (t) => {
  const db = await freshDb(t);
  const { sessionId } = await startSession(db.pool, input());
  const before = await ageHeartbeat(db, sessionId, 3_600);

  const result = await heartbeat(db.pool, sessionId, 'worker');
  assert.equal(result.status, 'ok');
  assert.ok(result.status === 'ok' && result.stall);
  assert.equal(result.stall.kind, 'HEARTBEAT_STALL');
  assert.equal(result.stall.start.getTime(), before.getTime());

  const recorded = await gaps(db);
  assert.deepEqual(recorded.map((gap) => gap.kind), ['HEARTBEAT_STALL']);
  assert.ok((recorded[0]?.gap_end.getTime() ?? 0) - (recorded[0]?.gap_start.getTime() ?? 0) >= 3_600_000);

  const again = await heartbeat(db.pool, sessionId, 'worker');
  assert.ok(again.status === 'ok' && again.stall === null, 'the stall is recorded once');
});

test('a process that was replaced while frozen learns it lost its session', async (t) => {
  const db = await freshDb(t);
  const frozen = await startSession(db.pool, input());
  await ageHeartbeat(db, frozen.sessionId, 120);
  const replacement = await startSession(db.pool, input({ pid: 5555 }));

  assert.deepEqual(await heartbeat(db.pool, frozen.sessionId, 'worker'), { status: 'lost' });
  assert.equal(await stopSession(db.pool, frozen.sessionId, 'worker'), false);
  assert.equal((await sessionRow(db, replacement.sessionId))?.status, 'RUNNING', 'the replacement is unaffected');
});

test('a stop request reaches the process on its next heartbeat', async (t) => {
  const db = await freshDb(t);
  const worker = await startSession(db.pool, input());
  const api = await startSession(db.pool, input({ component: 'api' }));

  assert.deepEqual(await requestStop(db.pool, ['worker']), ['worker']);
  const workerBeat = await heartbeat(db.pool, worker.sessionId, 'worker');
  const apiBeat = await heartbeat(db.pool, api.sessionId, 'api');
  assert.ok(workerBeat.status === 'ok' && workerBeat.stopRequested);
  assert.ok(apiBeat.status === 'ok' && !apiBeat.stopRequested, 'only the named component is asked');

  assert.deepEqual(await requestStop(db.pool, ['worker']), [], 'a pending request is not repeated');
  assert.deepEqual((await requestStop(db.pool, ['api', 'worker'])).sort(), ['api']);
});

test('session changes are written to the audit log', async (t) => {
  const db = await freshDb(t);
  const first = await startSession(db.pool, input());
  await ageHeartbeat(db, first.sessionId, 120);
  const second = await startSession(db.pool, input({ pid: 5555 }));
  await requestStop(db.pool, ['worker']);
  await stopSession(db.pool, second.sessionId, 'worker');

  const audit = await db.pool.query<{ action: string }>('SELECT action FROM audit_log ORDER BY id');
  assert.deepEqual(
    audit.rows.map((row) => row.action),
    ['session.started', 'session.abandoned', 'session.started', 'session.stop_requested', 'session.stopped'],
  );
});
