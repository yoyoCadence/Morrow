import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createPool } from '../db/pool.js';
import { capturingLogger, createTestDb, type TestDb } from '../test-support/db.js';
import { claimJob, completeJob } from './job-queue.js';
import { advanceSchedule, type Schedule, Scheduler } from './scheduler.js';

let db: TestDb;
let sessionId: string;
before(async () => {
  db = await createTestDb();
  const session = await db.pool.query<{ id: string }>(
    "INSERT INTO run_sessions (component, mode, host, pid, app_version) VALUES ('worker', 'RESEARCH', 'h', 1, 't') RETURNING id",
  );
  sessionId = session.rows[0]?.id ?? '';
});
after(() => db.close());

// schedule_gaps is append-only, so every test uses its own schedule instead of cleaning up, and its
// own job kind, so claiming a job never takes another test's.
let counter = 0;
function minutely(overrides: Partial<Schedule> = {}): Schedule {
  counter += 1;
  return { name: `test.s${counter}`, kind: `test.slot${counter}`, everyMs: 60_000, ...overrides };
}
const at = (time: string) => new Date(`2026-10-14T${time}Z`);
const advance = (schedule: Schedule, time: string) => advanceSchedule(db.pool, schedule, { at: at(time), sessionId });

async function jobsOf(schedule: Schedule) {
  const rows = await db.pool.query<{ id: string; dedupe_key: string; status: string; payload: Record<string, unknown>; max_attempts: number }>(
    "SELECT id, dedupe_key, status, payload, max_attempts FROM jobs WHERE payload->>'schedule' = $1 ORDER BY id",
    [schedule.name],
  );
  return rows.rows;
}

async function gapsOf(schedule: Schedule) {
  const rows = await db.pool.query<{ reason: string; gap_start: Date; gap_end: Date; missed_slots: string; detected_by_session_id: string }>(
    'SELECT reason, gap_start, gap_end, missed_slots, detected_by_session_id FROM schedule_gaps WHERE schedule = $1 ORDER BY id',
    [schedule.name],
  );
  return rows.rows.map((row) => `${row.reason} ${row.gap_start.toISOString().slice(11, 16)}–${row.gap_end.toISOString().slice(11, 16)} ×${row.missed_slots}`);
}

/** Starts and finishes a schedule's oldest queued job, as a worker would. */
async function run(schedule: Schedule): Promise<void> {
  const job = await claimJob(db.pool, { workerId: 'test', kinds: [schedule.kind], leaseMs: 60_000 });
  assert.ok(job, 'a queued job');
  assert.ok(await completeJob(db.pool, job.id, 'test'));
}

test('the first slot is enqueued once, with the slot in its key and payload', async () => {
  const schedule = minutely({ payload: { scope: 'warm' } });
  const first = await advance(schedule, '03:00:30');
  assert.equal(first.kind, 'enqueued');
  assert.equal(first.slotStart.toISOString(), '2026-10-14T03:00:00.000Z');
  assert.equal((await advance(schedule, '03:00:59.999')).kind, 'up_to_date');

  const jobs = await jobsOf(schedule);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0]?.dedupe_key, `schedule:${schedule.name}:2026-10-14T03:00:00.000Z`);
  assert.deepEqual(jobs[0]?.payload, { scope: 'warm', schedule: schedule.name, slot_start: '2026-10-14T03:00:00.000Z' });
  assert.equal(jobs[0]?.max_attempts, 1, 'the next slot is the retry');
  assert.deepEqual(await gapsOf(schedule), [], 'nothing was promised before the first slot');
});

test('each new slot is enqueued once the previous job has started', async () => {
  const schedule = minutely();
  await advance(schedule, '03:00:10');
  await claimJob(db.pool, { workerId: 'test', kinds: [schedule.kind], leaseMs: 60_000 });
  assert.equal((await advance(schedule, '03:01:05')).kind, 'enqueued', 'the previous job is running, not waiting');
  await run(schedule);
  assert.equal((await advance(schedule, '03:02:00')).kind, 'enqueued');
  assert.equal((await jobsOf(schedule)).length, 3);
  assert.deepEqual(await gapsOf(schedule), []);
});

test('after downtime only the current slot runs, and the missed slots are one gap', async () => {
  const schedule = minutely();
  await advance(schedule, '03:00:00');
  await run(schedule);

  const back = await advance(schedule, '03:10:30');
  assert.equal(back.kind, 'enqueued');
  assert.equal(back.slotStart.toISOString(), '2026-10-14T03:10:00.000Z');
  assert.equal((await jobsOf(schedule)).length, 2, 'the nine missed slots are not run late');
  assert.deepEqual(await gapsOf(schedule), ['NOT_SCHEDULED 03:01–03:10 ×9']);
  const detected = await db.pool.query('SELECT detected_by_session_id FROM schedule_gaps WHERE schedule = $1', [schedule.name]);
  assert.equal(detected.rows[0]?.detected_by_session_id, sessionId);
});

test('a slot whose predecessor has not started is skipped, and the skipped run is one BACKLOG gap', async () => {
  const schedule = minutely();
  await advance(schedule, '03:00:00');
  assert.equal((await advance(schedule, '03:01:00')).kind, 'skipped_backlog');
  assert.equal((await advance(schedule, '03:02:00')).kind, 'skipped_backlog');
  assert.equal((await jobsOf(schedule)).length, 1, 'nothing piles up behind the waiting job');
  assert.deepEqual(await gapsOf(schedule), [], 'recorded when the backlog ends');

  await claimJob(db.pool, { workerId: 'test', kinds: [schedule.kind], leaseMs: 60_000 });
  assert.equal((await advance(schedule, '03:03:00')).kind, 'enqueued');
  assert.deepEqual(await gapsOf(schedule), ['BACKLOG 03:01–03:03 ×2']);
});

test('a backlog that runs into downtime ends where the downtime starts', async () => {
  const schedule = minutely();
  await advance(schedule, '03:00:00');
  await advance(schedule, '03:01:00');
  // The worker stops with the 03:00 job still queued, and starts again at 03:10.
  assert.equal((await advance(schedule, '03:10:00')).kind, 'skipped_backlog', 'the old job is still waiting');
  assert.deepEqual(await gapsOf(schedule), ['BACKLOG 03:01–03:02 ×1', 'NOT_SCHEDULED 03:02–03:10 ×8']);

  await run(schedule);
  assert.equal((await advance(schedule, '03:11:00')).kind, 'enqueued');
  assert.deepEqual(await gapsOf(schedule), ['BACKLOG 03:01–03:02 ×1', 'NOT_SCHEDULED 03:02–03:10 ×8', 'BACKLOG 03:10–03:11 ×1']);
});

test('a changed slot length starts a new series, and a clock moving back enqueues nothing', async () => {
  const schedule = minutely();
  await advance(schedule, '03:00:00');
  await run(schedule);
  const longer = { ...schedule, everyMs: 300_000 };
  const changed = await advanceSchedule(db.pool, longer, { at: at('03:22:00'), sessionId });
  assert.deepEqual([changed.kind, changed.slotStart.toISOString()], ['enqueued', '2026-10-14T03:20:00.000Z']);
  assert.deepEqual(await gapsOf(schedule), [], 'old slots do not map onto the new ones');

  await run(schedule);
  assert.equal((await advanceSchedule(db.pool, longer, { at: at('03:12:00'), sessionId })).kind, 'up_to_date');
  assert.equal((await jobsOf(schedule)).length, 2);
});

test('concurrent ticks enqueue a slot once', async () => {
  const schedule = minutely();
  const first = await Promise.all(Array.from({ length: 6 }, () => advance(schedule, '03:00:00')));
  assert.equal(first.filter((outcome) => outcome.kind === 'enqueued').length, 1);
  await run(schedule);
  const second = await Promise.all(Array.from({ length: 6 }, () => advance(schedule, '03:01:00')));
  assert.equal(second.filter((outcome) => outcome.kind === 'enqueued').length, 1);
  assert.equal((await jobsOf(schedule)).length, 2);
  assert.deepEqual(await gapsOf(schedule), []);
});

test('the scheduler touches the database once per slot and survives a failing one', async () => {
  const schedule = minutely();
  let now = at('03:00:05');
  const { logger, output } = capturingLogger((text) => text);
  // Counts the transactions the scheduler opens.
  let connections = 0;
  const pool = new Proxy(db.pool, {
    get(target, key) {
      if (key === 'connect') connections += 1;
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const scheduler = new Scheduler({ pool, logger, schedules: [schedule], sessionId, now: () => now });

  await scheduler.tick();
  assert.equal(connections, 1);
  await scheduler.tick();
  now = at('03:00:59');
  await scheduler.tick();
  assert.equal(connections, 1, 'no query until the next slot begins');
  assert.equal((await jobsOf(schedule)).length, 1);

  await run(schedule);
  now = at('03:01:00');
  await scheduler.tick();
  assert.equal((await jobsOf(schedule)).length, 2);

  const dead = createPool('postgres://unused@127.0.0.1:1/unused', { applicationName: 'morrow-test' });
  try {
    const failing = new Scheduler({ pool: dead, logger, schedules: [minutely()], sessionId, now: () => now });
    await failing.tick();
  } finally {
    await dead.end();
  }
  assert.match(output(), /schedule could not be advanced/);
});
