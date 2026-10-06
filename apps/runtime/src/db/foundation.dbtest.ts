import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { SCHEMA_VERSION, solanaAssetId, type NewEvent } from '@morrow/core';
import type { z } from 'zod';
import { appendEvent } from '../events/event-store.js';
import { createTestDb, expectPgError, type TestDb } from '../test-support/db.js';
import { writeAudit } from './audit.js';
import { PG_RESTRICT_VIOLATION, withTransaction } from './pool.js';
import { readRawPayload, sha256Hex, storeRawObservation, type RawObservationInput } from './raw-store.js';

let db: TestDb;
before(async () => {
  db = await createTestDb();
});
after(() => db.close());

const MINDS = solanaAssetId('4SzWdVbXC7JiAtY5rH5MGc8HJPFAv6sSG97QEsjSpump');

function observation(overrides: Partial<RawObservationInput> = {}): RawObservationInput {
  return {
    provider: 'dexscreener',
    providerGroup: 'dexscreener',
    capability: 'market.tokens',
    requestMethod: 'GET',
    requestUrl: 'https://api.example.com/tokens/v1/solana/x',
    requestFingerprint: sha256Hex('fingerprint'),
    reason: 'scheduled',
    outcome: 'OK',
    httpStatus: 200,
    contentType: 'application/json',
    body: Buffer.from('{"pairs":[]}'),
    errorClass: null,
    errorDetail: null,
    durationMs: 12,
    observedAt: new Date(),
    runSessionId: null,
    ...overrides,
  };
}

function event(dedupeKey: string): z.input<typeof NewEvent> {
  return {
    schema_version: SCHEMA_VERSION,
    dedupe_key: dedupeKey,
    domain: 'market',
    action: 'snapshot.recorded',
    subject: MINDS,
    payload_version: 1,
    payload: { price_usd: '0.0000123' },
    event_time: null,
    observed_at: new Date().toISOString(),
    provenance: {
      provider: 'dexscreener',
      provider_group: 'dexscreener',
      parser_version: 'test.v1',
      raw_sha256: sha256Hex('raw'),
      evidence_refs: ['raw_observation:1'],
      slot: null,
      commitment: null,
      coverage: { completeness: 'UNKNOWN' },
    },
    severity: 'INFO',
    confidence: null,
    causation_id: null,
    correlation_id: null,
  };
}

test('identical response bodies are stored once and referenced by every observation', async () => {
  const body = Buffer.from(`{"unique":"${Math.random()}"}`);
  const first = await storeRawObservation(db.pool, observation({ body }));
  const second = await storeRawObservation(db.pool, observation({ body }));

  assert.notEqual(first.id, second.id);
  assert.equal(first.payloadSha256, sha256Hex(body));
  assert.equal(second.payloadSha256, first.payloadSha256);
  const payloads = await db.pool.query('SELECT 1 FROM raw_payloads WHERE sha256 = $1', [first.payloadSha256]);
  assert.equal(payloads.rowCount, 1);
});

test('raw bytes come back exactly as received, even when they are not valid text', async () => {
  const body = Buffer.from([0xff, 0x00, 0x7b, 0xc3, 0x28, 0x0d, 0x0a]);
  const stored = await storeRawObservation(db.pool, observation({ body }));
  assert.ok(stored.payloadSha256);
  const readBack = await readRawPayload(db.pool, stored.payloadSha256);
  assert.ok(readBack?.equals(body));
  assert.equal(await readRawPayload(db.pool, sha256Hex('never stored')), null);
});

test('a failed request is evidence too, with no payload', async () => {
  const stored = await storeRawObservation(
    db.pool,
    observation({ body: null, outcome: 'TLS_UNTRUSTED', httpStatus: null, contentType: null, errorClass: 'SELF_SIGNED_CERT_IN_CHAIN', errorDetail: 'fetch failed' }),
  );
  assert.equal(stored.payloadSha256, null);
  const row = await db.pool.query<{ outcome: string; error_class: string }>(
    'SELECT outcome, error_class FROM raw_observations WHERE id = $1',
    [stored.id],
  );
  assert.deepEqual(row.rows[0], { outcome: 'TLS_UNTRUSTED', error_class: 'SELF_SIGNED_CERT_IN_CHAIN' });
});

test('available_at is assigned by the database, after the observation time', async () => {
  const observedAt = new Date(Date.now() - 60_000);
  const stored = await storeRawObservation(db.pool, observation({ observedAt }));
  assert.ok(stored.availableAt.getTime() > observedAt.getTime() + 59_000, 'a late-stored record keeps its real availability time');
});

test('appending the same event twice stores it once', async () => {
  const key = `test:event:${Math.random()}`;
  const first = await appendEvent(db.pool, event(key));
  const second = await appendEvent(db.pool, event(key));

  assert.equal(first.inserted, true);
  assert.deepEqual(second, { eventId: first.eventId, inserted: false });
  const rows = await db.pool.query<{ event_time: Date | null; available_at: Date; subject: string }>(
    'SELECT event_time, available_at, subject FROM events WHERE dedupe_key = $1',
    [key],
  );
  assert.equal(rows.rowCount, 1);
  assert.equal(rows.rows[0]?.event_time, null, 'a missing source time is not replaced by the fetch time');
  assert.ok(rows.rows[0]?.available_at instanceof Date);
  assert.equal(rows.rows[0]?.subject, MINDS);
});

test('an invalid event is rejected before it reaches the database', async () => {
  const key = `test:event:${Math.random()}`;
  await assert.rejects(appendEvent(db.pool, { ...event(key), subject: 'MINDS' }));
  await assert.rejects(appendEvent(db.pool, { ...event(key), confidence: '2' }));
  const rows = await db.pool.query('SELECT 1 FROM events WHERE dedupe_key = $1', [key]);
  assert.equal(rows.rowCount, 0);
});

test('an event written in a transaction that rolls back does not exist', async () => {
  const key = `test:event:${Math.random()}`;
  await assert.rejects(
    withTransaction(db.pool, async (tx) => {
      await appendEvent(tx, event(key));
      throw new Error('abort');
    }),
    /abort/,
  );
  const rows = await db.pool.query('SELECT 1 FROM events WHERE dedupe_key = $1', [key]);
  assert.equal(rows.rowCount, 0);
});

test('evidence, events and logs cannot be changed, deleted or truncated', async () => {
  // Make sure every append-only table has a row to attack.
  const raw = await storeRawObservation(db.pool, observation({ body: Buffer.from('append-only') }));
  await appendEvent(db.pool, event(`test:event:${Math.random()}`));
  await writeAudit(db.pool, { actor: 'test', action: 'test.entry' });
  const session = await db.pool.query<{ id: string }>(
    "INSERT INTO run_sessions (component, mode, host, pid, app_version) VALUES ('api', 'OFF', 'h', 1, 't') RETURNING id",
  );
  const sessionId = session.rows[0]?.id;
  await db.pool.query(
    `INSERT INTO session_gaps (component, kind, gap_start, gap_end, detected_by_session_id)
     VALUES ('api', 'OFFLINE', now() - interval '1 hour', now(), $1)`,
    [sessionId],
  );
  await db.pool.query(
    `INSERT INTO quota_events (provider, bucket, period_start, capability, reason, units, decision, used_after, warn_at, hard_stop_at)
     VALUES ('okx', 'basic', '2026-10-01', 'x', 'probe', 1, 'ALLOW', 1, 70000, 85000)`,
  );
  await db.pool.query(
    "INSERT INTO provider_probes (provider, capability, outcome, doc_verified, raw_observation_id) VALUES ('okx', 'x', 'OK', false, $1)",
    [raw.id],
  );
  await db.pool.query(
    `INSERT INTO parse_quarantine (raw_observation_id, parser_version, record_ref, field_path, raw_value, reason)
     VALUES ($1, 'test@1', '$', '$.x', '0.5', 'UNIT_UNVERIFIED')`,
    [raw.id],
  );

  const mutations: Record<string, string> = {
    raw_payloads: 'byte_length = byte_length',
    raw_observations: "outcome = 'OK'",
    events: "severity = 'CRITICAL'",
    session_gaps: 'gap_end = gap_end',
    quota_events: 'units = units',
    provider_probes: "outcome = 'OK'",
    audit_log: "actor = 'someone-else'",
    parse_quarantine: "reason = 'OK'",
  };
  for (const [table, assignment] of Object.entries(mutations)) {
    const before = await db.pool.query(`SELECT count(*)::int AS n FROM ${table}`);
    assert.ok((before.rows[0] as { n: number }).n > 0, `${table} has rows`);

    await expectPgError(() => db.pool.query(`UPDATE ${table} SET ${assignment}`), PG_RESTRICT_VIOLATION);
    await expectPgError(() => db.pool.query(`DELETE FROM ${table}`), PG_RESTRICT_VIOLATION);
    await expectPgError(() => db.pool.query(`TRUNCATE ${table} CASCADE`), PG_RESTRICT_VIOLATION);

    const afterwards = await db.pool.query(`SELECT count(*)::int AS n FROM ${table}`);
    assert.deepEqual(afterwards.rows[0], before.rows[0], `${table} is unchanged`);
  }
});
