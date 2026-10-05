import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createTestDb, type TestDb } from '../test-support/db.js';
import { findQuotaPolicy, getQuotaViews, periodStart, reserveQuota, type QuotaPolicy } from './quota-ledger.js';

let db: TestDb;
before(async () => {
  db = await createTestDb();
});
after(() => db.close());

const AT = new Date('2026-10-05T12:00:00Z');
let counter = 0;
/** A small budget in its own bucket, so tests do not see each other's usage. */
function policy(): QuotaPolicy {
  counter += 1;
  return { provider: 'test', bucket: `bucket-${counter}`, sourceLimit: 12, warnAt: 7, hardStopAt: 10, basis: 'test' };
}
const reserve = (p: QuotaPolicy, units = 1, at = AT) =>
  reserveQuota(db.pool, p, { capability: 'cap', reason: 'scheduled', units, at });

test('usage is allowed, then warned about, then stopped', async () => {
  const p = policy();
  const decisions = [];
  for (let i = 0; i < 12; i += 1) decisions.push(await reserve(p));

  assert.deepEqual(
    decisions.map((d) => d.decision),
    [
      ...Array<string>(6).fill('ALLOW'),
      ...Array<string>(4).fill('ALLOW_WARN'),
      ...Array<string>(2).fill('DENY_HARD_STOP'),
    ],
  );
  assert.deepEqual(decisions.map((d) => d.usedAfter), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 10, 10]);
  assert.deepEqual(
    decisions.map((d) => d.crossedWarn),
    [false, false, false, false, false, false, true, false, false, false, false, false],
    'the warning fires once, on the reservation that crosses the line',
  );
});

test('a multi-unit reservation that would pass the hard stop is denied whole', async () => {
  const p = policy();
  assert.equal((await reserve(p, 8)).usedAfter, 8);
  const denied = await reserve(p, 3);
  assert.deepEqual({ decision: denied.decision, usedAfter: denied.usedAfter }, { decision: 'DENY_HARD_STOP', usedAfter: 8 });
  assert.equal((await reserve(p, 2)).decision, 'ALLOW_WARN', 'a smaller request that fits is still allowed');
  assert.equal((await reserve(p, 1)).decision, 'DENY_HARD_STOP');
});

test('a jump across the warning line reports the crossing', async () => {
  const p = policy();
  await reserve(p, 5);
  const crossing = await reserve(p, 4);
  assert.deepEqual(crossing, { decision: 'ALLOW_WARN', usedAfter: 9, crossedWarn: true });
});

test('concurrent reservations can never exceed the hard stop', async () => {
  const p = policy();
  const decisions = await Promise.all(Array.from({ length: 60 }, () => reserve(p)));

  const allowed = decisions.filter((d) => d.decision !== 'DENY_HARD_STOP').length;
  assert.equal(allowed, p.hardStopAt);
  assert.equal(decisions.length - allowed, 60 - p.hardStopAt);
  const stored = await db.pool.query<{ used: string }>(
    'SELECT used FROM quota_counters WHERE provider = $1 AND bucket = $2',
    [p.provider, p.bucket],
  );
  assert.equal(Number(stored.rows[0]?.used), p.hardStopAt);
});

test('every attempt is recorded with its reason, including denied ones', async () => {
  const p = policy();
  await reserveQuota(db.pool, p, { capability: 'holders', reason: 'scheduled', units: 9, at: AT });
  await reserveQuota(db.pool, p, { capability: 'holders', reason: 'retry', units: 1, at: AT });
  await reserveQuota(db.pool, p, { capability: 'probe.cap', reason: 'probe', units: 1, at: AT });
  await reserveQuota(db.pool, p, { capability: 'holders', reason: 'manual', units: 1, at: AT });

  const events = await db.pool.query<{ capability: string; reason: string; units: number; decision: string; used_after: string }>(
    `SELECT capability, reason, units, decision, used_after FROM quota_events
      WHERE provider = $1 AND bucket = $2 ORDER BY id`,
    [p.provider, p.bucket],
  );
  assert.deepEqual(
    events.rows.map((row) => [row.capability, row.reason, row.units, row.decision, Number(row.used_after)]),
    [
      ['holders', 'scheduled', 9, 'ALLOW_WARN', 9],
      ['holders', 'retry', 1, 'ALLOW_WARN', 10],
      ['probe.cap', 'probe', 1, 'DENY_HARD_STOP', 10],
      ['holders', 'manual', 1, 'DENY_HARD_STOP', 10],
    ],
    'retries and probes draw from the same budget as scheduled work',
  );
});

test('each billing period has its own budget', async () => {
  const p = policy();
  const october = new Date('2026-10-31T23:59:59Z');
  const november = new Date('2026-11-01T00:00:00Z');
  await reserve(p, 10, october);
  assert.equal((await reserve(p, 1, october)).decision, 'DENY_HARD_STOP');
  assert.deepEqual(await reserve(p, 1, november), { decision: 'ALLOW', usedAfter: 1, crossedWarn: false });
});

test('periods are UTC calendar months', () => {
  assert.equal(periodStart(new Date('2026-10-05T12:00:00Z')), '2026-10-01');
  assert.equal(periodStart(new Date('2026-10-31T23:59:59.999Z')), '2026-10-01');
  assert.equal(periodStart(new Date('2026-11-01T00:00:00Z')), '2026-11-01');
  // 07:30 on 1 January in Taipei is still December in UTC.
  assert.equal(periodStart(new Date('2026-12-31T23:30:00Z')), '2026-12-01');
});

test('unit counts must be positive integers', async () => {
  const p = policy();
  for (const units of [0, -1, 1.5, Number.NaN]) {
    await assert.rejects(reserve(p, units), /positive integer/, String(units));
  }
});

test('the health view reports each configured bucket for the current period', async () => {
  const okx = findQuotaPolicy('okx', 'basic');
  const at = new Date('2031-03-15T00:00:00Z');
  await reserveQuota(db.pool, okx, { capability: 'x', reason: 'scheduled', units: 70_000, at });

  const views = await getQuotaViews(db.pool, at);
  assert.deepEqual(
    views.map((view) => [view.provider, view.bucket, view.used, view.state]),
    [
      ['okx', 'basic', 70_000, 'WARN'],
      ['okx', 'premium', 0, 'OK'],
      ['helius', 'credits', 0, 'OK'],
    ],
  );

  await reserveQuota(db.pool, okx, { capability: 'x', reason: 'scheduled', units: 15_000, at });
  const basic = (await getQuotaViews(db.pool, at)).find((view) => view.bucket === 'basic');
  assert.deepEqual({ used: basic?.used, state: basic?.state, period: basic?.period_start }, { used: 85_000, state: 'HARD_STOP', period: '2031-03-01' });
  assert.throws(() => findQuotaPolicy('okx', 'nonexistent'), /No quota policy/);
});
