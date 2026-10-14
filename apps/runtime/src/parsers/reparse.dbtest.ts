import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { storeRawObservation, type RawObservationInput } from '../db/raw-store.js';
import { appendEvent } from '../events/event-store.js';
import { createTestDb, defer, type TestDb } from '../test-support/db.js';
import { DEXSCREENER_TOKENS_PARSER_VERSION } from './dexscreener-tokens.js';
import { WSOL_TOKENS_RESPONSE } from './fixtures/dexscreener-tokens-wsol.js';
import { ingestRawObservation, PARSE_CONSUMER, parsedMarkKey } from './ingest.js';
import { planReparse, reparse, type ReparseResult } from './reparse.js';

const CURRENT = DEXSCREENER_TOKENS_PARSER_VERSION;
const OLDER = 'dexscreener-tokens@1';

async function freshDb(t: TestContext): Promise<TestDb> {
  const db = await createTestDb();
  defer(t, () => db.close());
  return db;
}

let minute = 0;

/** A stored DEX Screener response; each call is observed a minute after the last. */
async function store(db: TestDb, overrides: Partial<RawObservationInput> = {}): Promise<string> {
  minute += 1;
  const stored = await storeRawObservation(db.pool, {
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
    observedAt: new Date(Date.parse(WSOL_TOKENS_RESPONSE.observedAt) + minute * 60_000),
    runSessionId: null,
    ...overrides,
  });
  return stored.id;
}

async function count(db: TestDb, sql: string, params: unknown[] = []): Promise<number> {
  const result = await db.pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${sql}`, params);
  return result.rows[0]?.n ?? -1;
}

const eventsCiting = (db: TestDb, id: string, version: string): Promise<number> =>
  count(db, "events WHERE provenance -> 'evidence_refs' ? $1 AND provenance ->> 'parser_version' = $2", [`raw_observation:${id}`, version]);

const only = (results: readonly ReparseResult[]): ReparseResult => {
  assert.equal(results.length, 1, 'one registered parser');
  return results[0] as ReparseResult;
};

test('the plan counts the successful responses the current parser version has not processed', async (t) => {
  const db = await freshDb(t);
  const parsed = await store(db);
  await ingestRawObservation(db.pool, parsed);
  await store(db);
  await store(db);
  // Not read by any parser: an error response, and a capability without a parser.
  await store(db, { outcome: 'RATE_LIMITED', httpStatus: 429, body: Buffer.from('{"error":"slow down"}') });
  await store(db, { capability: 'market.search' });

  assert.deepEqual(await planReparse(db.pool), [
    { provider: 'dexscreener', capability: 'market.tokens', parserVersion: CURRENT, responses: 3, parsed: 1, pending: 2 },
  ]);
  assert.equal(await count(db, 'audit_log'), 0, 'planning writes nothing');
});

test('a reparse parses what is pending, once, and keeps what earlier versions produced', async (t) => {
  const db = await freshDb(t);
  // Parsed by an earlier version: its mark and its event, as that version left them.
  const older = await store(db);
  await db.pool.query('INSERT INTO consumer_inbox (consumer, message_key) VALUES ($1, $2)', [PARSE_CONSUMER, parsedMarkKey(OLDER, older)]);
  const olderEvent = await appendEvent(db.pool, {
    schema_version: 1,
    dedupe_key: `${OLDER}:raw_observation:${older}:pool:Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE`,
    domain: 'market',
    action: 'pair.snapshot',
    subject: 'solana:mainnet-beta:So11111111111111111111111111111111111111112',
    payload_version: 1,
    payload: { written_by: OLDER },
    event_time: null,
    observed_at: new Date().toISOString(),
    provenance: {
      provider: 'dexscreener',
      provider_group: 'dexscreener',
      parser_version: OLDER,
      raw_sha256: WSOL_TOKENS_RESPONSE.sha256,
      evidence_refs: [`raw_observation:${older}`],
      slot: null,
      commitment: null,
      coverage: { completeness: 'COMPLETE' },
    },
    severity: 'INFO',
    confidence: null,
    causation_id: null,
    correlation_id: null,
  });
  const before = await db.pool.query('SELECT * FROM events WHERE event_id = $1', [olderEvent.eventId]);
  // Never parsed at all, for example stored before the parser existed.
  const never = await store(db);
  // Already parsed by the current version.
  const current = await store(db);
  await ingestRawObservation(db.pool, current);

  const progress: number[] = [];
  const first = only(await reparse(db.pool, { onProgress: (totals) => progress.push(totals.parsed) }));
  assert.deepEqual(first, {
    provider: 'dexscreener',
    capability: 'market.tokens',
    parserVersion: CURRENT,
    parsed: 2,
    alreadyParsed: 0,
    eventsInserted: 2,
    eventsExisting: 0,
    eventsConflicting: 0,
    quarantined: 16,
  });
  assert.deepEqual(progress, [1, 2]);
  for (const id of [older, never, current]) assert.equal(await eventsCiting(db, id, CURRENT), 1, `observation ${id}`);

  const after = await db.pool.query('SELECT * FROM events WHERE event_id = $1', [olderEvent.eventId]);
  assert.deepEqual(after.rows, before.rows, "the earlier version's event is exactly as it was");
  assert.equal(await eventsCiting(db, older, OLDER), 1);

  const second = only(await reparse(db.pool));
  assert.equal(second.parsed, 0, 'nothing is pending any more');
  assert.equal(second.eventsInserted, 0);
  assert.deepEqual((await planReparse(db.pool))[0]?.pending, 0);
});

test('every pending response is parsed once across batch boundaries', async (t) => {
  const db = await freshDb(t);
  const ids: string[] = [];
  for (let i = 0; i < 5; i += 1) ids.push(await store(db));
  // One in the middle is already done, so batches are not simply consecutive ids.
  await ingestRawObservation(db.pool, ids[2] as string);

  const result = only(await reparse(db.pool, { batchSize: 2 }));
  assert.equal(result.parsed, 4);
  assert.equal(result.alreadyParsed, 0);
  for (const id of ids) assert.equal(await eventsCiting(db, id, CURRENT), 1, `observation ${id}`);
  assert.equal(await count(db, 'consumer_inbox WHERE consumer = $1', [PARSE_CONSUMER]), 5);
});

test('two reparses at once parse each response once between them', async (t) => {
  const db = await freshDb(t);
  const ids: string[] = [];
  for (let i = 0; i < 6; i += 1) ids.push(await store(db));

  const [a, b] = (await Promise.all([reparse(db.pool, { batchSize: 2 }), reparse(db.pool, { batchSize: 2 })])).map(only);
  assert.equal((a?.parsed ?? 0) + (b?.parsed ?? 0), 6, `${a?.parsed} + ${b?.parsed}`);
  assert.equal((a?.eventsInserted ?? 0) + (b?.eventsInserted ?? 0), 6);
  for (const id of ids) assert.equal(await eventsCiting(db, id, CURRENT), 1, `observation ${id}`);
  assert.equal(await count(db, 'event_conflicts'), 0);
});

test('a reparse is recorded in the audit log with what it did', async (t) => {
  const db = await freshDb(t);
  await store(db);
  await reparse(db.pool);
  const audit = await db.pool.query<{ actor: string; action: string; detail: unknown }>('SELECT actor, action, detail FROM audit_log');
  assert.deepEqual(audit.rows, [
    {
      actor: 'operator',
      action: 'parser.reparse.completed',
      detail: {
        parsers: [
          {
            parser_version: CURRENT,
            capability: 'dexscreener/market.tokens',
            parsed: 1,
            already_parsed: 0,
            events_inserted: 1,
            events_existing: 0,
            events_conflicting: 0,
            quarantined: 8,
          },
        ],
      },
    },
  ]);
});
