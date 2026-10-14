import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import {
  EventPage,
  OBSERVATION_EVENTS_MAX,
  QuarantinePage,
  RAW_BODY_PREVIEW_BYTES,
  RawObservationDetail,
  RawObservationPage,
} from '@morrow/core';
import { createPool } from '../db/pool.js';
import { storeRawObservation, type RawObservationInput } from '../db/raw-store.js';
import { createRedactor } from '../logging/redact.js';
import { WSOL_TOKENS_RESPONSE } from '../parsers/fixtures/dexscreener-tokens-wsol.js';
import { ingestRawObservation } from '../parsers/ingest.js';
import { createTestDb, silentLogger, type TestDb } from '../test-support/db.js';
import { buildApiServer } from './server.js';

const WSOL = 'solana:mainnet-beta:So11111111111111111111111111111111111111112';
const SECRET = 'helius-key-0123456789';
const PORT = 8787;
const HOST = { host: `127.0.0.1:${PORT}` };

let db: TestDb;
let app: Awaited<ReturnType<typeof buildApiServer>>;
/** Two parsed DEX Screener responses, then an error response that echoes a key, a large body and a binary one. */
const ids: Record<'first' | 'second' | 'echo' | 'large' | 'binary', string> = { first: '', second: '', echo: '', large: '', binary: '' };

function observation(overrides: Partial<RawObservationInput> = {}): RawObservationInput {
  return {
    provider: 'dexscreener',
    providerGroup: 'dexscreener',
    capability: 'market.tokens',
    requestMethod: 'GET',
    requestUrl: 'https://api.dexscreener.com/tokens/v1/solana/So11111111111111111111111111111111111111112',
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
    ...overrides,
  };
}

before(async () => {
  db = await createTestDb();
  ids.first = (await storeRawObservation(db.pool, observation())).id;
  await ingestRawObservation(db.pool, ids.first);
  ids.second = (await storeRawObservation(db.pool, observation({ observedAt: new Date(Date.parse(WSOL_TOKENS_RESPONSE.observedAt) + 60_000) }))).id;
  await ingestRawObservation(db.pool, ids.second);
  ids.echo = (
    await storeRawObservation(
      db.pool,
      observation({
        provider: 'helius',
        providerGroup: 'helius',
        capability: 'rpc.health',
        requestUrl: 'https://mainnet.helius-rpc.com/',
        outcome: 'UNAUTHORIZED',
        httpStatus: 401,
        contentType: `application/json; key=${SECRET}`,
        body: Buffer.from(`{"error":"invalid api key ${SECRET}"}`),
        errorClass: `HTTP_401_${SECRET}`,
        errorDetail: `rejected ${SECRET}`,
      }),
    )
  ).id;
  ids.large = (await storeRawObservation(db.pool, observation({ body: Buffer.alloc(RAW_BODY_PREVIEW_BYTES + 5_000, 'x') }))).id;
  ids.binary = (await storeRawObservation(db.pool, observation({ contentType: 'application/octet-stream', body: Buffer.from([0xff, 0xfe, 0x01]) }))).id;
  app = await buildApiServer({ pool: db.pool, logger: silentLogger, mode: 'OFF', version: 'test', port: PORT, redact: createRedactor([SECRET]) });
});
after(async () => {
  await app.close();
  await db.close();
});

const get = async (url: string) => {
  const response = await app.inject({ url, headers: HOST });
  return { status: response.statusCode, body: response.json() as Record<string, unknown>, headers: response.headers };
};

test("a subject's events come newest first, a page at a time, in the shared contract", async () => {
  const all = await get(`/api/events?subject=${WSOL}`);
  assert.equal(all.status, 200);
  assert.equal(all.headers['cache-control'], 'no-store');
  const events = EventPage.parse(all.body).events;
  assert.equal(events.length, 2, 'one pair snapshot per response');
  assert.ok(Number(events[0]?.recorded_seq) > Number(events[1]?.recorded_seq), 'newest first');
  assert.deepEqual(events[0]?.provenance.evidence_refs, [`raw_observation:${ids.second}`]);

  const first = EventPage.parse((await get(`/api/events?subject=${WSOL}&limit=1`)).body);
  assert.equal(first.events[0]?.recorded_seq, events[0]?.recorded_seq);
  assert.equal(first.next_before, events[0]?.recorded_seq);
  const second = EventPage.parse((await get(`/api/events?subject=${WSOL}&limit=1&before=${first.next_before}`)).body);
  assert.equal(second.events[0]?.recorded_seq, events[1]?.recorded_seq);
  assert.equal(second.next_before, null, 'the last page says so');

  assert.equal(EventPage.parse((await get('/api/events')).body).events.length, 2, 'every subject when none is given');
  assert.deepEqual(EventPage.parse((await get('/api/events?subject=system:worker')).body).events, []);
});

test('an observation shows its body, its quarantined fields and the events made from it', async () => {
  const response = await get(`/api/raw-observations/${ids.first}`);
  assert.equal(response.status, 200);
  const detail = RawObservationDetail.parse(response.body);
  assert.equal(detail.observation.id, ids.first);
  assert.equal(detail.body?.text, WSOL_TOKENS_RESPONSE.body);
  assert.equal(detail.body?.truncated, false);
  assert.equal(detail.body?.byte_length, Buffer.byteLength(WSOL_TOKENS_RESPONSE.body));
  assert.ok(detail.quarantine.length > 0, 'the stored response has fields the parser would not guess');
  assert.ok(detail.quarantine.every((entry) => entry.raw_observation_id === ids.first));
  assert.deepEqual(
    detail.events.map((event) => [event.subject, event.action]),
    [[WSOL, 'pair.snapshot']],
  );
  assert.equal(detail.events_truncated, false);
  assert.ok(OBSERVATION_EVENTS_MAX >= 30);
});

test('secrets an error response echoed are removed when shown, and the stored bytes are not changed', async () => {
  const detail = RawObservationDetail.parse((await get(`/api/raw-observations/${ids.echo}`)).body);
  assert.equal(detail.body?.text, '{"error":"invalid api key [REDACTED]"}');
  assert.equal(detail.body?.redacted, true);
  assert.equal(detail.observation.error_detail, 'rejected [REDACTED]');
  assert.equal(detail.observation.content_type, 'application/json; key=[REDACTED]', 'response headers come from the provider too');
  assert.equal(detail.observation.error_class, 'HTTP_401_[REDACTED]');
  assert.doesNotMatch(JSON.stringify(detail), new RegExp(SECRET));
  const stored = await db.pool.query<{ body: Buffer }>(
    'SELECT p.body FROM raw_observations o JOIN raw_payloads p ON p.sha256 = o.payload_sha256 WHERE o.id = $1',
    [ids.echo],
  );
  assert.match(stored.rows[0]?.body.toString() ?? '', new RegExp(SECRET), 'the evidence itself stays exact');
});

test('a large body is cut, and a binary one is not shown as text', async () => {
  const large = RawObservationDetail.parse((await get(`/api/raw-observations/${ids.large}`)).body);
  assert.equal(large.body?.truncated, true);
  assert.equal(large.body?.text?.length, RAW_BODY_PREVIEW_BYTES);
  assert.equal(large.body?.byte_length, RAW_BODY_PREVIEW_BYTES + 5_000);
  const binary = RawObservationDetail.parse((await get(`/api/raw-observations/${ids.binary}`)).body);
  assert.equal(binary.body?.text, null);
  assert.equal(binary.body?.byte_length, 3);
});

test('observations are listed newest first and can be narrowed to a provider and capability', async () => {
  const all = RawObservationPage.parse((await get('/api/raw-observations')).body);
  assert.deepEqual(
    all.observations.map((entry) => entry.id),
    [ids.binary, ids.large, ids.echo, ids.second, ids.first],
  );
  const helius = RawObservationPage.parse((await get('/api/raw-observations?provider=helius&capability=rpc.health')).body);
  assert.deepEqual(helius.observations.map((entry) => entry.id), [ids.echo]);
  const paged = RawObservationPage.parse((await get('/api/raw-observations?limit=2')).body);
  assert.equal(paged.next_before, ids.large);
});

test('quarantined fields are listed newest first and can be narrowed to a reason', async () => {
  const all = QuarantinePage.parse((await get('/api/quarantine?limit=200')).body);
  assert.ok(all.entries.length > 0);
  const ids_ = all.entries.map((entry) => Number(entry.id));
  assert.deepEqual(ids_, [...ids_].sort((a, b) => b - a), 'newest first');
  const reason = all.entries[0]?.reason ?? '';
  const narrowed = QuarantinePage.parse((await get(`/api/quarantine?reason=${encodeURIComponent(reason)}&limit=200`)).body);
  assert.ok(narrowed.entries.length > 0 && narrowed.entries.every((entry) => entry.reason === reason));
});

test('unusable parameters are a 400 that names the problem, and a missing observation is a 404', async () => {
  assert.deepEqual(await get('/api/events?subject=WSOL').then((r) => [r.status, r.body]), [400, { error: 'INVALID_SUBJECT' }]);
  assert.deepEqual(await get('/api/events?limit=0').then((r) => [r.status, r.body]), [400, { error: 'INVALID_LIMIT' }]);
  assert.deepEqual(await get('/api/quarantine?before=abc').then((r) => [r.status, r.body]), [400, { error: 'INVALID_CURSOR' }]);
  assert.deepEqual(await get('/api/raw-observations/0').then((r) => [r.status, r.body]), [400, { error: 'INVALID_ID' }]);
  assert.deepEqual(await get('/api/raw-observations/999999').then((r) => [r.status, r.body]), [404, { error: 'NOT_FOUND' }]);
  assert.equal((await app.inject({ url: '/api/events', method: 'POST', headers: HOST })).statusCode, 405, 'read-only');
});

test('without a database the evidence endpoints say so, without passing the error to the page', async () => {
  const dead = createPool('postgres://unused@127.0.0.1:1/unused', { applicationName: 'morrow-test' });
  const down = await buildApiServer({ pool: dead, logger: silentLogger, mode: 'OFF', version: 'test', port: PORT });
  try {
    for (const url of ['/api/events', '/api/raw-observations', `/api/raw-observations/${ids.first}`, '/api/quarantine']) {
      const response = await down.inject({ url, headers: HOST });
      assert.deepEqual([response.statusCode, response.json()], [503, { error: 'EVIDENCE_UNAVAILABLE' }], url);
    }
  } finally {
    await down.close();
    await dead.end();
  }
});
