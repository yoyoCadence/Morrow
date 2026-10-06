import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { PairSnapshot } from '@morrow/core';
import { withTransaction } from '../db/pool.js';
import { storeRawObservation, type RawObservationInput } from '../db/raw-store.js';
import { createTestDb, type TestDb } from '../test-support/db.js';
import { dexscreenerTokensParser, DEXSCREENER_TOKENS_PARSER_VERSION } from './dexscreener-tokens.js';
import { WSOL_TOKENS_RESPONSE } from './fixtures/dexscreener-tokens-wsol.js';
import { enqueueParse, ingestRawObservation, PARSE_JOB_KIND } from './ingest.js';

const WSOL_ASSET = 'solana:mainnet-beta:So11111111111111111111111111111111111111112';

let db: TestDb;

before(async () => {
  db = await createTestDb();
});

after(async () => {
  await db.close();
});

function observation(overrides: Partial<RawObservationInput> = {}): RawObservationInput {
  return {
    provider: 'dexscreener',
    providerGroup: 'dexscreener',
    capability: 'market.tokens',
    requestMethod: 'GET',
    requestUrl: 'https://api.dexscreener.com/tokens/v1/solana/So11111111111111111111111111111111111111112',
    requestFingerprint: 'a'.repeat(64),
    reason: 'probe',
    outcome: 'OK',
    httpStatus: 200,
    contentType: 'application/json',
    body: Buffer.from(WSOL_TOKENS_RESPONSE.body, 'utf8'),
    errorClass: null,
    errorDetail: null,
    durationMs: 113,
    observedAt: new Date(WSOL_TOKENS_RESPONSE.observedAt),
    runSessionId: null,
    ...overrides,
  };
}

async function count(sql: string, params: unknown[]): Promise<number> {
  const result = await db.pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${sql}`, params);
  return result.rows[0]?.n ?? -1;
}

test('a stored response becomes events and quarantine rows, once', async () => {
  const raw = await storeRawObservation(db.pool, observation());

  const first = await ingestRawObservation(db.pool, raw.id);
  assert.deepEqual(first, {
    rawObservationId: raw.id,
    parserVersion: DEXSCREENER_TOKENS_PARSER_VERSION,
    skipped: null,
    eventsInserted: 1,
    eventsExisting: 0,
    quarantined: 8,
  });

  const stored = await db.pool.query<{
    subject: string; event_time: Date | null; observed_at: Date; available_at: Date; payload: unknown; provenance: { evidence_refs: string[]; raw_sha256: string };
  }>(
    "SELECT subject, event_time, observed_at, available_at, payload, provenance FROM events WHERE domain = 'market' AND action = 'pair.snapshot' AND provenance->'evidence_refs' ? $1",
    [`raw_observation:${raw.id}`],
  );
  assert.equal(stored.rows.length, 1);
  const event = stored.rows[0];
  assert.equal(event?.subject, WSOL_ASSET);
  assert.equal(event?.event_time, null);
  assert.equal(event?.observed_at.toISOString(), WSOL_TOKENS_RESPONSE.observedAt);
  assert.ok(event && event.available_at.getTime() >= event.observed_at.getTime(), 'available once stored, not before');
  assert.equal(event?.provenance.raw_sha256, WSOL_TOKENS_RESPONSE.sha256);
  assert.deepEqual(PairSnapshot.parse(event?.payload).price_usd, { state: 'KNOWN', value: '120.78' });

  const quarantine = await db.pool.query<{ field_path: string; raw_value: string; reason: string }>(
    'SELECT field_path, raw_value, reason FROM parse_quarantine WHERE raw_observation_id = $1 ORDER BY field_path',
    [raw.id],
  );
  assert.equal(quarantine.rows.length, 8);
  assert.deepEqual(quarantine.rows.find((row) => row.field_path === '$[0].volume.h24'), {
    field_path: '$[0].volume.h24',
    raw_value: '94425154.75',
    reason: 'UNIT_UNVERIFIED',
  });

  const again = await ingestRawObservation(db.pool, raw.id);
  assert.equal(again.skipped, 'ALREADY_PROCESSED');
  assert.equal(await count('events WHERE subject = $1', [WSOL_ASSET]), 1);
  assert.equal(await count('parse_quarantine WHERE raw_observation_id = $1', [raw.id]), 8);
});

test('the same body observed again is a new snapshot, not a duplicate', async () => {
  const before = await count('events WHERE subject = $1', [WSOL_ASSET]);
  const later = await storeRawObservation(db.pool, observation({ observedAt: new Date('2026-10-05T14:53:18.133Z') }));
  assert.equal((await ingestRawObservation(db.pool, later.id)).eventsInserted, 1);
  assert.equal(await count('events WHERE subject = $1', [WSOL_ASSET]), before + 1);
});

test('error responses and capabilities without a parser are not parsed', async () => {
  const failed = await storeRawObservation(
    db.pool,
    observation({ outcome: 'SERVER_ERROR', httpStatus: 500, body: Buffer.from('{"error":"internal"}') }),
  );
  assert.equal((await ingestRawObservation(db.pool, failed.id)).skipped, 'NOT_OK');

  const unparsed = await storeRawObservation(db.pool, observation({ provider: 'jupiter', providerGroup: 'jupiter', capability: 'tokens.recent' }));
  assert.deepEqual(await ingestRawObservation(db.pool, unparsed.id), {
    rawObservationId: unparsed.id,
    parserVersion: null,
    skipped: 'NO_PARSER',
    eventsInserted: 0,
    eventsExisting: 0,
    quarantined: 0,
  });

  for (const id of [failed.id, unparsed.id]) {
    assert.equal(await count('parse_quarantine WHERE raw_observation_id = $1', [id]), 0);
    assert.equal(await count("events WHERE provenance->'evidence_refs' ? $1", [`raw_observation:${id}`]), 0);
  }
  await assert.rejects(ingestRawObservation(db.pool, '999999999'), /does not exist/);
});

test('a parse job is created once per observation and parser version, and not at all if the transaction rolls back', async () => {
  const raw = await storeRawObservation(db.pool, observation());
  await withTransaction(db.pool, async (tx) => {
    await enqueueParse(tx, raw.id, dexscreenerTokensParser);
    await enqueueParse(tx, raw.id, dexscreenerTokensParser);
  });
  const jobs = await db.pool.query<{ payload: unknown }>(
    "SELECT payload FROM jobs WHERE kind = $1 AND payload->>'raw_observation_id' = $2",
    [PARSE_JOB_KIND, raw.id],
  );
  assert.deepEqual(jobs.rows.map((row) => row.payload), [{ raw_observation_id: raw.id }]);

  await assert.rejects(
    withTransaction(db.pool, async (tx) => {
      const lost = await storeRawObservation(tx, observation());
      await enqueueParse(tx, lost.id, dexscreenerTokensParser);
      throw new Error('abort');
    }),
    /abort/,
  );
  assert.equal(await count("jobs WHERE kind = $1 AND payload->>'raw_observation_id' NOT IN (SELECT id::text FROM raw_observations)", [PARSE_JOB_KIND]), 0);
});
