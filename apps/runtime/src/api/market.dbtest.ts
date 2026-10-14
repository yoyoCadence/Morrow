import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { knownValue, MarketPairsPage, SCHEMA_VERSION, unknownValue } from '@morrow/core';
import type pg from 'pg';
import { storeRawObservation } from '../db/raw-store.js';
import { appendEvent } from '../events/event-store.js';
import { WSOL_TOKENS_RESPONSE } from '../parsers/fixtures/dexscreener-tokens-wsol.js';
import { ingestRawObservation } from '../parsers/ingest.js';
import { createTestDb, defer, silentLogger, type TestDb } from '../test-support/db.js';
import { LATEST_PAIR_SNAPSHOTS_SQL, listLatestPairs } from './market.js';
import { buildApiServer } from './server.js';

const WSOL = 'So11111111111111111111111111111111111111112';
const BONK = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const POOL = {
  a: 'Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE',
  b: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  c: 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
  d: 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc',
  e: '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',
} as const;
const T0 = Date.parse('2026-10-14T00:00:00.000Z');
const at = (minutes: number): string => new Date(T0 + minutes * 60_000).toISOString();

async function freshDb(t: TestContext): Promise<TestDb> {
  const db = await createTestDb();
  defer(t, () => db.close());
  return db;
}

const perWindow = <T>(value: T) => ({ m5: value, h1: value, h6: value, h24: value });

/** A PairSnapshot payload like the DEX Screener parser writes. */
function snapshot(pool: string, base: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const unitUnverified = unknownValue('UNIT_UNVERIFIED');
  return {
    pool_address: pool,
    venue: knownValue('orca'),
    venue_labels: ['wp'],
    base_asset: `solana:mainnet-beta:${base}`,
    quote_asset: knownValue(`solana:mainnet-beta:${USDC}`),
    price_usd: knownValue('1'),
    price_in_quote: knownValue('1'),
    liquidity_usd: knownValue('1000'),
    volume_usd: perWindow(unitUnverified),
    price_change: perWindow(unitUnverified),
    txns: perWindow({ buys: knownValue('1'), sells: knownValue('2') }),
    fdv_usd: unitUnverified,
    market_cap_usd: unitUnverified,
    pool_created_at: knownValue('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

let sequence = 0;

/** Appends a pair.snapshot event observed at `observedAt`; each call is a different fact. */
async function append(
  db: pg.Pool,
  payload: Record<string, unknown>,
  observedAt: string,
  payloadVersion = 1,
): Promise<string> {
  sequence += 1;
  const result = await appendEvent(db, {
    schema_version: SCHEMA_VERSION,
    dedupe_key: `test:${sequence}:${String(payload['pool_address'])}`,
    domain: 'market',
    action: 'pair.snapshot',
    subject: String(payload['base_asset']),
    payload_version: payloadVersion,
    payload,
    event_time: null,
    observed_at: observedAt,
    provenance: {
      provider: 'dexscreener',
      provider_group: 'dexscreener',
      parser_version: 'dexscreener-tokens@2',
      raw_sha256: 'a'.repeat(64),
      evidence_refs: [`raw_observation:${sequence}`],
      slot: null,
      commitment: null,
      coverage: { completeness: 'COMPLETE' },
    },
    severity: 'INFO',
    confidence: null,
    causation_id: null,
    correlation_id: null,
  });
  assert.ok(result.inserted);
  return result.eventId;
}

const priceOf = (page: MarketPairsPage, pool: string): unknown =>
  page.pairs.find((pair) => pair.snapshot.pool_address === pool)?.snapshot.price_usd;

test('each pool shows its most recently observed snapshot, whatever order it was recorded in', async (t) => {
  const db = await freshDb(t);
  // Start at recorded_seq 9 so the reparse below is 12: as text "9" sorts after "12".
  await db.pool.query("SELECT setval(pg_get_serial_sequence('events', 'recorded_seq'), 8)");
  await append(db.pool, snapshot(POOL.a, WSOL, { price_usd: knownValue('2') }), at(10));
  // Backfilled later, but observed earlier: it is history, not the current state.
  await append(db.pool, snapshot(POOL.a, WSOL, { price_usd: knownValue('1') }), at(5));
  await append(db.pool, snapshot(POOL.b, WSOL, { price_usd: knownValue('7') }), at(1));

  const first = MarketPairsPage.parse(await listLatestPairs(db.pool));
  assert.deepEqual(priceOf(first, POOL.a), knownValue('2'));
  assert.deepEqual(priceOf(first, POOL.b), knownValue('7'));
  assert.equal(first.pairs.length, 2, 'one row per pool');

  // A reparse of the same response: observed at the same moment, recorded later.
  const reparsed = await append(db.pool, snapshot(POOL.a, WSOL, { price_usd: knownValue('2.5') }), at(10));
  const second = await listLatestPairs(db.pool);
  assert.deepEqual(priceOf(second, POOL.a), knownValue('2.5'));
  const row = second.pairs.find((pair) => pair.snapshot.pool_address === POOL.a);
  assert.equal(row?.event_id, reparsed);
  assert.equal(row?.observed_at, at(10));
  assert.equal(row?.provider, 'dexscreener');
  assert.equal(row?.parser_version, 'dexscreener-tokens@2');
  assert.match(row?.evidence_refs[0] ?? '', /^raw_observation:\d+$/);
  assert.deepEqual(second.rejected, []);
  assert.equal(second.truncated, false);
});

test('pools are grouped by base asset, the most liquid first, unknown liquidity last', async (t) => {
  const db = await freshDb(t);
  // As text "30.5" > "2000" > "100"; as numbers 2000 > 100 > 30.5.
  await append(db.pool, snapshot(POOL.a, WSOL, { liquidity_usd: knownValue('100') }), at(1));
  await append(db.pool, snapshot(POOL.b, WSOL, { liquidity_usd: unknownValue('MISSING') }), at(1));
  await append(db.pool, snapshot(POOL.c, WSOL, { liquidity_usd: knownValue('2000') }), at(1));
  await append(db.pool, snapshot(POOL.e, WSOL, { liquidity_usd: knownValue('30.5') }), at(1));
  await append(db.pool, snapshot(POOL.d, WSOL, { liquidity_usd: knownValue('9999') }), at(1));
  await append(db.pool, snapshot(POOL.d, BONK, { liquidity_usd: knownValue('1') }), at(2));

  const page = await listLatestPairs(db.pool);
  // POOL.d's latest snapshot names BONK as its base, so that is where it is listed.
  assert.deepEqual(
    page.pairs.map((pair) => [pair.snapshot.base_asset.slice(-4), pair.snapshot.pool_address]),
    [
      ['B263', POOL.d],
      ['1112', POOL.c],
      ['1112', POOL.a],
      ['1112', POOL.e],
      ['1112', POOL.b],
    ],
  );
});

test('a latest snapshot this build cannot read is listed as rejected, never replaced by an older one', async (t) => {
  const db = await freshDb(t);
  await append(db.pool, snapshot(POOL.a, WSOL, { price_usd: knownValue('1') }), at(1));
  const newerVersion = await append(db.pool, snapshot(POOL.a, WSOL), at(2), 2);
  await append(db.pool, snapshot(POOL.b, WSOL), at(1));
  // A bare number where an Observed value belongs, and a liquidity PostgreSQL cannot cast to numeric.
  const malformed = await append(db.pool, snapshot(POOL.b, WSOL, { price_usd: '120.78', liquidity_usd: knownValue('1,000') }), at(2));
  await append(db.pool, snapshot(POOL.c, WSOL), at(1));

  const page = await listLatestPairs(db.pool);
  assert.deepEqual(
    page.pairs.map((pair) => pair.snapshot.pool_address),
    [POOL.c],
    'neither pool falls back to the snapshot before its unreadable one',
  );
  assert.deepEqual(
    page.rejected.map((entry) => [entry.pool_address, entry.problem, entry.event_id]).sort(),
    [
      [POOL.a, 'PAYLOAD_VERSION', newerVersion],
      [POOL.b, 'PAYLOAD_REJECTED', malformed],
    ].sort(),
  );
  MarketPairsPage.parse(page);
});

test('past the maximum the answer says it is cut, and keeps the pools that come first by address', async (t) => {
  const db = await freshDb(t);
  for (const pool of [POOL.a, POOL.b, POOL.c]) await append(db.pool, snapshot(pool, WSOL), at(1));
  // The database's own order, whatever its collation does with mixed case.
  const ordered = await db.pool.query<{ pool: string }>(
    "SELECT DISTINCT payload ->> 'pool_address' AS pool FROM events ORDER BY 1",
  );
  const firstTwo = ordered.rows.slice(0, 2).map((row) => row.pool);

  const cut = await listLatestPairs(db.pool, 2);
  assert.equal(cut.truncated, true);
  assert.deepEqual(cut.pairs.map((pair) => pair.snapshot.pool_address).sort(), [...firstTwo].sort());

  const whole = await listLatestPairs(db.pool, 3);
  assert.equal(whole.truncated, false);
  assert.equal(whole.pairs.length, 3);
});

test('no snapshots is an empty answer, not an error', async (t) => {
  const db = await freshDb(t);
  assert.deepEqual(await listLatestPairs(db.pool), { pairs: [], rejected: [], truncated: false });
});

test('every read of events goes through the pair snapshot index', async (t) => {
  const db = await freshDb(t);
  const client = await db.pool.connect();
  defer(t, () => client.release());
  await client.query('BEGIN');
  // On a table this small a sequential scan is cheaper, so take it off the table.
  await client.query('SET LOCAL enable_seqscan = off');
  const plan = await client.query<{ 'QUERY PLAN': unknown }>(`EXPLAIN (FORMAT JSON) ${LATEST_PAIR_SNAPSHOTS_SQL}`, [501]);
  await client.query('ROLLBACK');
  const text = JSON.stringify(plan.rows[0]?.['QUERY PLAN']);
  const reads = text.match(/"Relation Name":"events"/g)?.length ?? 0;
  const indexed = text.match(/"Index Name":"events_pair_snapshot_pool_idx"/g)?.length ?? 0;
  assert.equal(reads, 3, 'the first pool, each next pool, and the latest snapshot of each');
  assert.equal(indexed, 3);
});

test('GET /api/market/pairs serves the parsed real response with its UNKNOWN values and reasons', async (t) => {
  const db = await freshDb(t);
  const stored = await storeRawObservation(db.pool, {
    provider: 'dexscreener',
    providerGroup: 'dexscreener',
    capability: 'market.tokens',
    requestMethod: 'GET',
    requestUrl: `https://api.dexscreener.com/tokens/v1/solana/${WSOL}`,
    requestFingerprint: 'a'.repeat(64),
    reason: 'scheduled',
    outcome: 'OK',
    httpStatus: 200,
    contentType: 'application/json',
    body: Buffer.from(WSOL_TOKENS_RESPONSE.body, 'utf8'),
    errorClass: null,
    errorDetail: null,
    durationMs: 113,
    observedAt: new Date(WSOL_TOKENS_RESPONSE.observedAt),
    runSessionId: null,
  });
  await ingestRawObservation(db.pool, stored.id);
  const app = await buildApiServer({ pool: db.pool, logger: silentLogger, mode: 'OFF', version: 'test', port: 8787 });
  defer(t, () => app.close());

  const response = await app.inject({ method: 'GET', url: '/api/market/pairs', headers: { host: '127.0.0.1:8787' } });
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers['cache-control'], 'no-store');
  const page = MarketPairsPage.parse(response.json());
  assert.equal(page.pairs.length, 1);
  const [pair] = page.pairs;
  assert.equal(pair?.observed_at, WSOL_TOKENS_RESPONSE.observedAt);
  assert.deepEqual(pair?.evidence_refs, [`raw_observation:${stored.id}`]);
  assert.deepEqual(pair?.snapshot.price_usd, knownValue('120.78'));
  assert.deepEqual(pair?.snapshot.liquidity_usd, knownValue('30663136.63'));
  // Sent, but in a unit nobody has confirmed: quarantined, not guessed.
  assert.deepEqual(pair?.snapshot.volume_usd.h24, unknownValue('UNIT_UNVERIFIED'));
  assert.deepEqual(pair?.snapshot.price_change.h24, unknownValue('UNIT_UNVERIFIED'));
  // Not sent at all for this pool.
  assert.deepEqual(pair?.snapshot.market_cap_usd, unknownValue('MISSING'));
  assert.deepEqual(pair?.snapshot.fdv_usd, unknownValue('MISSING'));
});

test('GET /api/market/pairs answers 503 when the database cannot', async (t) => {
  const failing = {
    query: async () => {
      throw new Error('connection refused');
    },
  } as unknown as pg.Pool;
  const app = await buildApiServer({ pool: failing, logger: silentLogger, mode: 'OFF', version: 'test', port: 8787 });
  defer(t, () => app.close());
  const response = await app.inject({ method: 'GET', url: '/api/market/pairs', headers: { host: '127.0.0.1:8787' } });
  assert.equal(response.statusCode, 503);
  assert.deepEqual(response.json(), { error: 'MARKET_UNAVAILABLE' });
});
