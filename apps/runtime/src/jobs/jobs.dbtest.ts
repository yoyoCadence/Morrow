import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { withTransaction } from '../db/pool.js';
import { sha256Hex, storeRawObservation } from '../db/raw-store.js';
import { createRedactor } from '../logging/redact.js';
import { createTestDb, silentLogger, type TestDb } from '../test-support/db.js';
import { claimJob, completeJob, countJobs, enqueueJob, failJob, getJobState, markProcessed } from './job-queue.js';
import { defaultRetryDelayMs, JobWorker, sleep, type JobHandler } from './worker.js';

let db: TestDb;
before(async () => {
  db = await createTestDb();
});
after(() => db.close());
beforeEach(async () => {
  await db.pool.query('DELETE FROM jobs');
  await db.pool.query('DELETE FROM consumer_inbox');
});

const KINDS = ['test.work'];

/** Makes a held lease look expired, as if its worker had died long ago. No waiting on the clock. */
async function expireLease(jobId: string): Promise<void> {
  const result = await db.pool.query(
    "UPDATE jobs SET lease_expires_at = clock_timestamp() - interval '1 second' WHERE id = $1 AND status = 'leased'",
    [jobId],
  );
  assert.equal(result.rowCount, 1, 'expected a leased job');
}
const claim = (workerId: string, leaseMs = 60_000) => claimJob(db.pool, { workerId, kinds: KINDS, leaseMs });

test('a job enqueued in a transaction that rolls back never exists', async () => {
  const before = await db.pool.query('SELECT count(*)::int AS n FROM raw_observations');

  await assert.rejects(
    withTransaction(db.pool, async (tx) => {
      await storeRawObservation(tx, {
        provider: 'p', providerGroup: 'p', capability: 'c', requestMethod: 'GET', requestUrl: 'https://x.example/',
        requestFingerprint: sha256Hex('f'), reason: 'scheduled', outcome: 'OK', httpStatus: 200, contentType: null,
        body: Buffer.from('rolled back'), errorClass: null, errorDetail: null, durationMs: 1, observedAt: new Date(), runSessionId: null,
      });
      await enqueueJob(tx, { kind: 'test.work', payload: { step: 'parse' } });
      throw new Error('abort');
    }),
    /abort/,
  );

  assert.deepEqual(await countJobs(db.pool), { queued: 0, leased: 0, dead: 0 }, 'no orphan job');
  const afterwards = await db.pool.query('SELECT count(*)::int AS n FROM raw_observations');
  assert.deepEqual(afterwards.rows[0], before.rows[0], 'and no orphan evidence');
  assert.equal(await claim('w1'), null);
});

test('data and its follow-up job commit together', async () => {
  const jobId = await withTransaction(db.pool, async (tx) => {
    const raw = await storeRawObservation(tx, {
      provider: 'p', providerGroup: 'p', capability: 'c', requestMethod: 'GET', requestUrl: 'https://x.example/',
      requestFingerprint: sha256Hex('f'), reason: 'scheduled', outcome: 'OK', httpStatus: 200, contentType: null,
      body: Buffer.from('committed'), errorClass: null, errorDetail: null, durationMs: 1, observedAt: new Date(), runSessionId: null,
    });
    return (await enqueueJob(tx, { kind: 'test.work', payload: { raw_observation_id: raw.id } })).jobId;
  });
  const job = await claim('w1');
  assert.equal(job?.id, jobId);
  assert.equal(typeof job?.payload.raw_observation_id, 'string');
});

test('enqueueing the same logical job again is a no-op', async () => {
  const first = await enqueueJob(db.pool, { kind: 'test.work', dedupeKey: 'slot:2026-10-05T12:00' });
  const second = await enqueueJob(db.pool, { kind: 'test.work', dedupeKey: 'slot:2026-10-05T12:00' });
  assert.deepEqual(second, { jobId: first.jobId, enqueued: false });
  assert.equal(first.enqueued, true);

  // Still a no-op after the job has finished: the key is used up for good.
  const job = await claim('w1');
  assert.ok(job);
  await completeJob(db.pool, job.id, 'w1');
  const third = await enqueueJob(db.pool, { kind: 'test.work', dedupeKey: 'slot:2026-10-05T12:00' });
  assert.deepEqual(third, { jobId: first.jobId, enqueued: false });
  assert.equal(await claim('w1'), null);

  // Jobs without a key are never merged.
  const a = await enqueueJob(db.pool, { kind: 'test.work' });
  const b = await enqueueJob(db.pool, { kind: 'test.work' });
  assert.notEqual(a.jobId, b.jobId);
});

test('competing workers never claim the same job', async () => {
  const total = 40;
  for (let i = 0; i < total; i += 1) await enqueueJob(db.pool, { kind: 'test.work', payload: { i } });

  const claimed: string[] = [];
  const drain = async (workerId: string): Promise<void> => {
    for (;;) {
      const job = await claim(workerId);
      if (!job) return;
      claimed.push(job.id);
      assert.equal(await completeJob(db.pool, job.id, workerId), true);
    }
  };
  await Promise.all(['w1', 'w2', 'w3', 'w4', 'w5', 'w6'].map(drain));

  assert.equal(claimed.length, total);
  assert.equal(new Set(claimed).size, total, 'each job was claimed exactly once');
});

test('jobs run oldest first and not before their run_at', async () => {
  const future = await enqueueJob(db.pool, { kind: 'test.work', runAt: new Date(Date.now() + 3_600_000) });
  const first = await enqueueJob(db.pool, { kind: 'test.work' });
  const second = await enqueueJob(db.pool, { kind: 'test.work' });

  assert.equal((await claim('w1'))?.id, first.jobId);
  assert.equal((await claim('w1'))?.id, second.jobId);
  assert.equal(await claim('w1'), null, 'the future job is not due');
  assert.equal((await getJobState(db.pool, future.jobId))?.status, 'queued');
});

test('a worker only claims kinds it can handle', async () => {
  await enqueueJob(db.pool, { kind: 'other.kind' });
  assert.equal(await claim('w1'), null);
  assert.equal(await claimJob(db.pool, { workerId: 'w1', kinds: [], leaseMs: 1_000 }), null);
  assert.equal((await claimJob(db.pool, { workerId: 'w1', kinds: ['other.kind'], leaseMs: 1_000 }))?.kind, 'other.kind');
});

test('a job whose worker vanished is redelivered, and the old worker cannot complete it', async () => {
  const { jobId } = await enqueueJob(db.pool, { kind: 'test.work' });
  const first = await claim('crashed-worker');
  assert.equal(first?.attempt, 1);
  assert.equal(await claim('w2'), null, 'the lease is still held');

  await expireLease(jobId);
  const second = await claim('w2');
  assert.deepEqual({ id: second?.id, attempt: second?.attempt }, { id: jobId, attempt: 2 });

  assert.equal(await completeJob(db.pool, jobId, 'crashed-worker'), false, 'the stale worker lost the lease');
  assert.equal(await failJob(db.pool, jobId, 'crashed-worker', 'late failure', 0), 'lease_lost');
  assert.equal(await completeJob(db.pool, jobId, 'w2'), true);
  assert.equal((await getJobState(db.pool, jobId))?.status, 'succeeded');
});

test('a failing job is retried after a delay and dead-lettered when attempts run out', async () => {
  const { jobId } = await enqueueJob(db.pool, { kind: 'test.work', maxAttempts: 2 });

  const first = await claim('w1');
  assert.ok(first);
  assert.equal(await failJob(db.pool, jobId, 'w1', 'boom 1', 3_600_000), 'retry');
  assert.equal(await claim('w1'), null, 'not retried before the delay has passed');

  await db.pool.query('UPDATE jobs SET run_at = clock_timestamp() WHERE id = $1', [jobId]);
  const second = await claim('w1');
  assert.equal(second?.attempt, 2);
  assert.equal(await failJob(db.pool, jobId, 'w1', 'boom 2', 0), 'dead');

  assert.deepEqual(await getJobState(db.pool, jobId), { status: 'dead', attempts: 2, lastError: 'boom 2' });
  assert.equal(await claim('w1'), null, 'a dead job is never claimed again');
  assert.equal((await countJobs(db.pool)).dead, 1);
});

test('a job that loses its lease on the final attempt is dead-lettered, not retried forever', async () => {
  const { jobId } = await enqueueJob(db.pool, { kind: 'test.work', maxAttempts: 1 });
  assert.ok(await claim('crashed-worker'));
  await expireLease(jobId);
  assert.equal(await claim('w2'), null);
  const state = await getJobState(db.pool, jobId);
  assert.equal(state?.status, 'dead');
  assert.match(state?.lastError ?? '', /lease expired/);
});

test('consumer dedupe: a message is processed once, and a rolled-back attempt does not count', async () => {
  assert.equal(await markProcessed(db.pool, 'parser', 'raw:1'), true);
  assert.equal(await markProcessed(db.pool, 'parser', 'raw:1'), false);
  assert.equal(await markProcessed(db.pool, 'other-consumer', 'raw:1'), true, 'consumers are independent');

  await assert.rejects(
    withTransaction(db.pool, async (tx) => {
      assert.equal(await markProcessed(tx, 'parser', 'raw:2'), true);
      throw new Error('effects failed');
    }),
  );
  assert.equal(await markProcessed(db.pool, 'parser', 'raw:2'), true, 'the failed attempt left no mark, so the retry runs');
});

test('redelivery of a job does not repeat its effects when the handler dedupes', async () => {
  // The handler does its work and records "done" in one transaction, then the
  // worker dies before completing the job. The redelivered job must be a no-op.
  let effects = 0;
  const handler = async (jobId: string): Promise<void> => {
    await withTransaction(db.pool, async (tx) => {
      if (!(await markProcessed(tx, 'test.work', `job:${jobId}`))) return;
      effects += 1;
    });
  };

  const { jobId } = await enqueueJob(db.pool, { kind: 'test.work' });
  const first = await claim('crashed-worker');
  assert.ok(first);
  await handler(first.id);
  await expireLease(jobId);

  const second = await claim('w2');
  assert.equal(second?.id, jobId);
  await handler(jobId);
  await completeJob(db.pool, jobId, 'w2');
  assert.equal(effects, 1);
});

function worker(handlers: Record<string, JobHandler>, redact: (text: string) => string = (text) => text): JobWorker {
  return new JobWorker({
    pool: db.pool,
    logger: silentLogger,
    workerId: 'w-test',
    handlers: new Map(Object.entries(handlers)),
    redact,
    pollIntervalMs: 10,
    retryDelayMs: () => 0,
  });
}

test('the worker completes a job whose handler succeeds', async () => {
  const seen: unknown[] = [];
  const { jobId } = await enqueueJob(db.pool, { kind: 'test.work', payload: { n: 7 } });
  const w = worker({ 'test.work': async (job) => void seen.push(job.payload) });

  assert.equal(await w.runOnce(), true);
  assert.equal(await w.runOnce(), false, 'nothing left');
  assert.deepEqual(seen, [{ n: 7 }]);
  assert.equal((await getJobState(db.pool, jobId))?.status, 'succeeded');
});

test('the worker records a failure without leaking secrets into the job row', async () => {
  const secret = 'helius-key-7f3a9c21';
  const { jobId } = await enqueueJob(db.pool, { kind: 'test.work', maxAttempts: 2 });
  const w = worker(
    {
      'test.work': async () => {
        throw new Error(`GET https://rpc.example/?api-key=${secret} failed`);
      },
    },
    createRedactor([secret]),
  );

  await w.runOnce();
  let state = await getJobState(db.pool, jobId);
  assert.equal(state?.status, 'queued', 'first failure is retried');
  assert.ok(!state?.lastError?.includes(secret));
  assert.match(state?.lastError ?? '', /\[REDACTED\]/);

  await w.runOnce();
  state = await getJobState(db.pool, jobId);
  assert.equal(state?.status, 'dead');
});

test('the worker loop drains the queue and stop() waits for the job in flight', async () => {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let finished = 0;
  const w = worker({
    'test.work': async () => {
      await gate;
      finished += 1;
    },
  });
  await enqueueJob(db.pool, { kind: 'test.work' });

  w.start();
  await sleep(100);
  assert.equal(finished, 0, 'the handler is blocked mid-job');

  let stopped = false;
  const stopping = w.stop().then(() => {
    stopped = true;
  });
  await sleep(50);
  assert.equal(stopped, false, 'stop() does not abandon a running job');

  release();
  await stopping;
  assert.equal(finished, 1);
  assert.deepEqual(await countJobs(db.pool), { queued: 0, leased: 0, dead: 0 });
});

test('retry delays grow and are capped', () => {
  assert.deepEqual([1, 2, 3, 4].map(defaultRetryDelayMs), [5_000, 10_000, 20_000, 40_000]);
  assert.equal(defaultRetryDelayMs(30), 300_000);
});
