import assert from 'node:assert/strict';
import { test } from 'node:test';
import { z } from 'zod';
import { solanaAssetId } from './asset-id.js';
import { CanonicalEvent, eventIdFor, NewEvent } from './event.js';
import { ENABLED_MODES, ModeNotEnabledError, OPERATING_MODES, requireEnabledMode } from './modes.js';
import { observedSchema } from './observed.js';
import { DecimalString, SCHEMA_VERSION, UIntString, UtcTimestamp } from './primitives.js';
import { TimeSemantics } from './provenance.js';

const MINDS = solanaAssetId('4SzWdVbXC7JiAtY5rH5MGc8HJPFAv6sSG97QEsjSpump');

function validEvent(): z.input<typeof NewEvent> {
  return {
    schema_version: SCHEMA_VERSION,
    dedupe_key: 'dexscreener:pair:abc:2026-10-05T00:00:00Z',
    domain: 'market',
    action: 'snapshot.recorded',
    subject: MINDS,
    payload_version: 1,
    payload: { price_usd: '0.0000123' },
    event_time: null,
    observed_at: '2026-10-05T12:00:00.000Z',
    provenance: {
      provider: 'dexscreener',
      provider_group: 'dexscreener',
      parser_version: 'dexscreener.tokens.v1',
      raw_sha256: 'a'.repeat(64),
      evidence_refs: ['raw_observation:1'],
      slot: null,
      commitment: null,
      coverage: { completeness: 'PARTIAL', note: 'pairs indexed by this provider only' },
    },
    severity: 'INFO',
    confidence: null,
    causation_id: null,
    correlation_id: null,
  };
}

test('a well-formed event is accepted', () => {
  assert.equal(NewEvent.safeParse(validEvent()).success, true);
});

test('an event may have no source time, and that is kept as null', () => {
  const parsed = NewEvent.parse(validEvent());
  assert.equal(parsed.event_time, null);
});

test('malformed events are rejected', () => {
  const cases: Array<[string, (event: Record<string, unknown>) => void]> = [
    ['symbol as subject', (e) => (e.subject = 'MINDS')],
    ['unknown domain', (e) => (e.domain = 'strategy')],
    ['uppercase action', (e) => (e.action = 'Snapshot')],
    ['local time', (e) => (e.observed_at = '2026-10-05T20:00:00+08:00')],
    ['confidence above 1', (e) => (e.confidence = '1.5')],
    ['float confidence', (e) => (e.confidence = 0.5)],
    ['wrong schema version', (e) => (e.schema_version = SCHEMA_VERSION + 1)],
    ['empty dedupe key', (e) => (e.dedupe_key = '')],
    ['unknown field', (e) => (e.extra = true)],
    ['no evidence', (e) => ((e.provenance as Record<string, unknown>).evidence_refs = [])],
  ];
  for (const [name, mutate] of cases) {
    const event = structuredClone(validEvent()) as Record<string, unknown>;
    mutate(event);
    assert.equal(NewEvent.safeParse(event).success, false, name);
  }
});

test('system subjects are allowed for non-asset events', () => {
  const event = { ...validEvent(), domain: 'system', action: 'session.started', subject: 'system:worker' };
  assert.equal(NewEvent.safeParse(event).success, true);
});

test('event ids are deterministic, distinct per key, and valid UUIDs', () => {
  const first = eventIdFor('key-1');
  assert.equal(first, eventIdFor('key-1'));
  assert.notEqual(first, eventIdFor('key-2'));
  assert.equal(z.uuid().safeParse(first).success, true);
  assert.equal(first[14], '8', 'version nibble');

  const stored = { ...validEvent(), event_id: first, available_at: '2026-10-05T12:00:01.000Z' };
  assert.equal(CanonicalEvent.safeParse(stored).success, true);
});

test('only OFF, RESEARCH and PAPER may run', () => {
  assert.deepEqual([...ENABLED_MODES], ['OFF', 'RESEARCH', 'PAPER']);
  for (const mode of ENABLED_MODES) assert.equal(requireEnabledMode(mode), mode);
  for (const mode of OPERATING_MODES.filter((m) => !(ENABLED_MODES as readonly string[]).includes(m))) {
    assert.throws(() => requireEnabledMode(mode), ModeNotEnabledError, mode);
  }
  for (const bad of ['paper', 'LIVE', '', 'PAPER ']) {
    assert.throws(() => requireEnabledMode(bad), ModeNotEnabledError, bad);
  }
});

test('primitive string contracts', () => {
  for (const good of ['0', '1', '18446744073709551615']) assert.equal(UIntString.safeParse(good).success, true, good);
  for (const bad of ['', '01', '-1', '1.0', '1e3', ' 1']) assert.equal(UIntString.safeParse(bad).success, false, bad);
  for (const good of ['0', '-0.5', '123.456']) assert.equal(DecimalString.safeParse(good).success, true, good);
  for (const bad of ['', '.5', '5.', '1e3', '1,000', '+1', '00.5']) assert.equal(DecimalString.safeParse(bad).success, false, bad);
  assert.equal(UtcTimestamp.safeParse('2026-10-05T12:00:00Z').success, true);
  assert.equal(UtcTimestamp.safeParse('2026-10-05 12:00:00').success, false);
});

test('time semantics keep the three times apart', () => {
  const times = { event_time: null, observed_at: '2026-10-05T12:00:00Z', available_at: '2026-10-05T12:00:01Z' };
  assert.equal(TimeSemantics.safeParse(times).success, true);
  assert.equal(TimeSemantics.safeParse({ observed_at: times.observed_at, available_at: times.available_at }).success, false, 'event_time must be stated, even as null');
});

test('Observed values cannot mix a state with the wrong fields', () => {
  const schema = observedSchema(DecimalString);
  assert.equal(schema.safeParse({ state: 'KNOWN', value: '1.5' }).success, true);
  assert.equal(schema.safeParse({ state: 'UNKNOWN', reason: 'MISSING' }).success, true);
  assert.equal(schema.safeParse({ state: 'UNKNOWN', value: '0', reason: 'MISSING' }).success, false, 'UNKNOWN carries no value');
  assert.equal(schema.safeParse({ state: 'KNOWN' }).success, false);
  assert.equal(schema.safeParse({ state: 'CONFLICTING', candidates: ['1'], reason: 'x' }).success, false, 'a conflict needs two candidates');
  assert.equal(schema.safeParse({ state: 'STALE', value: '1', reason: 'older than 5m' }).success, true);
});
