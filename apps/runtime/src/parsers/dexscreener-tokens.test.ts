import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { NewEvent, PairSnapshot } from '@morrow/core';
import { dexscreenerTokensParser, DEXSCREENER_TOKENS_PARSER_VERSION } from './dexscreener-tokens.js';
import { WSOL_TOKENS_RESPONSE } from './fixtures/dexscreener-tokens-wsol.js';
import type { StoredObservation } from './types.js';

const WSOL = 'So11111111111111111111111111111111111111112';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const POOL = 'Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE';

function observation(body: string, id = '1'): StoredObservation {
  return {
    id,
    provider: 'dexscreener',
    providerGroup: 'dexscreener',
    capability: 'market.tokens',
    observedAt: new Date(WSOL_TOKENS_RESPONSE.observedAt),
    payloadSha256: createHash('sha256').update(body).digest('hex'),
    body: Buffer.from(body, 'utf8'),
  };
}

/** The real response with one pair changed by `edit`. */
function edited(edit: (pair: Record<string, unknown>) => void): string {
  const pairs = JSON.parse(WSOL_TOKENS_RESPONSE.body) as Record<string, unknown>[];
  edit(pairs[0] as Record<string, unknown>);
  return JSON.stringify(pairs);
}

function onlyPayload(body: string) {
  const result = dexscreenerTokensParser.parse(observation(body));
  assert.equal(result.events.length, 1);
  return { payload: PairSnapshot.parse(result.events[0]?.payload), quarantined: result.quarantined };
}

test('the fixture is the stored response, byte for byte', () => {
  assert.equal(createHash('sha256').update(WSOL_TOKENS_RESPONSE.body, 'utf8').digest('hex'), WSOL_TOKENS_RESPONSE.sha256);
});

test('the real wrapped SOL response becomes one pair snapshot event', () => {
  const result = dexscreenerTokensParser.parse(observation(WSOL_TOKENS_RESPONSE.body));
  assert.equal(result.events.length, 1);
  const event = NewEvent.parse(result.events[0]);

  assert.deepEqual(
    { domain: event.domain, action: event.action, subject: event.subject, version: event.payload_version },
    { domain: 'market', action: 'pair.snapshot', subject: `solana:mainnet-beta:${WSOL}`, version: 1 },
  );
  assert.equal(event.dedupe_key, `${DEXSCREENER_TOKENS_PARSER_VERSION}:raw_observation:1:pool:${POOL}`);
  assert.equal(event.event_time, null, 'the response carries no time of its own; the fetch time is not substituted');
  assert.equal(event.observed_at, '2026-10-05T13:53:18.133Z');
  assert.deepEqual(event.provenance, {
    provider: 'dexscreener',
    provider_group: 'dexscreener',
    parser_version: DEXSCREENER_TOKENS_PARSER_VERSION,
    raw_sha256: WSOL_TOKENS_RESPONSE.sha256,
    evidence_refs: ['raw_observation:1'],
    slot: null,
    commitment: null,
    coverage: { completeness: 'COMPLETE' },
  });

  const payload = PairSnapshot.parse(event.payload);
  assert.equal(payload.pool_address, POOL);
  assert.deepEqual(payload.venue, { state: 'KNOWN', value: 'orca' });
  assert.deepEqual(payload.venue_labels, ['wp']);
  assert.equal(payload.base_asset, `solana:mainnet-beta:${WSOL}`);
  assert.deepEqual(payload.quote_asset, { state: 'KNOWN', value: `solana:mainnet-beta:${USDC}` });
  assert.deepEqual(payload.price_usd, { state: 'KNOWN', value: '120.78' });
  assert.deepEqual(payload.price_in_quote, { state: 'KNOWN', value: '120.7831' });
  assert.deepEqual(payload.liquidity_usd, { state: 'KNOWN', value: '30663136.63' });
  assert.deepEqual(payload.txns.m5, { buys: { state: 'KNOWN', value: '151' }, sells: { state: 'KNOWN', value: '245' } });
  assert.deepEqual(payload.txns.h24, { buys: { state: 'KNOWN', value: '39938' }, sells: { state: 'KNOWN', value: '33198' } });
  assert.deepEqual(payload.pool_created_at, { state: 'KNOWN', value: '2023-06-30T06:20:58.000Z' });

  // No documented unit: held back, not guessed.
  assert.deepEqual(payload.volume_usd.h24, { state: 'UNKNOWN', reason: 'UNIT_UNVERIFIED' });
  assert.deepEqual(payload.price_change.h1, { state: 'UNKNOWN', reason: 'UNIT_UNVERIFIED' });
  // Absent from this response: unknown, not zero.
  assert.deepEqual(payload.fdv_usd, { state: 'UNKNOWN', reason: 'MISSING' });
  assert.deepEqual(payload.market_cap_usd, { state: 'UNKNOWN', reason: 'MISSING' });

  assert.doesNotMatch(JSON.stringify(event.payload), /cdn\.dexscreener|x\.com|solana\.com/, 'promotional content is not carried');
});

test('values without a documented unit are quarantined with their exact source text', () => {
  const { quarantined } = dexscreenerTokensParser.parse(observation(WSOL_TOKENS_RESPONSE.body));
  const byPath = Object.fromEntries(quarantined.map((field) => [field.fieldPath, field]));
  assert.deepEqual(Object.keys(byPath).sort(), [
    '$[0].priceChange.h1', '$[0].priceChange.h24', '$[0].priceChange.h6', '$[0].priceChange.m5',
    '$[0].volume.h1', '$[0].volume.h24', '$[0].volume.h6', '$[0].volume.m5',
  ]);
  assert.deepEqual(byPath['$[0].volume.h24'], { recordRef: POOL, fieldPath: '$[0].volume.h24', rawValue: '94425154.75', reason: 'UNIT_UNVERIFIED' });
  assert.equal(byPath['$[0].volume.m5']?.rawValue, '1204154.8');
  assert.equal(byPath['$[0].priceChange.h6']?.rawValue, '-0.69');
  assert.equal(byPath['$[0].priceChange.m5']?.rawValue, '0.02');
});

test('parsing is deterministic', () => {
  const body = WSOL_TOKENS_RESPONSE.body;
  assert.deepEqual(dexscreenerTokensParser.parse(observation(body)), dexscreenerTokensParser.parse(observation(body)));
});

test('numbers keep every digit the source sent', () => {
  const body = WSOL_TOKENS_RESPONSE.body
    .replace('"priceUsd":"120.78"', '"priceUsd":120.123456789012345678')
    .replace('"usd":30663136.63', '"usd":1e3')
    .replace('"h24":94425154.75', '"h24":0.12345678901234567890123');
  const { payload, quarantined } = onlyPayload(body);
  assert.deepEqual(payload.price_usd, { state: 'KNOWN', value: '120.123456789012345678' });
  assert.deepEqual(payload.liquidity_usd, { state: 'KNOWN', value: '1000' }, 'an exponent is expanded exactly');
  assert.equal(quarantined.find((field) => field.fieldPath === '$[0].volume.h24')?.rawValue, '0.12345678901234567890123');
});

test('missing and placeholder values are UNKNOWN but not quarantined; uninterpretable ones are quarantined', () => {
  const missing = onlyPayload(edited((pair) => {
    pair['priceUsd'] = null;
    pair['priceNative'] = '--';
    (pair['quoteToken'] as Record<string, unknown>)['address'] = null;
    delete pair['pairCreatedAt'];
  }));
  assert.deepEqual(missing.payload.price_usd, { state: 'UNKNOWN', reason: 'MISSING' });
  assert.deepEqual(missing.payload.price_in_quote, { state: 'UNKNOWN', reason: 'PLACEHOLDER' });
  assert.deepEqual(missing.payload.quote_asset, { state: 'UNKNOWN', reason: 'MISSING' });
  assert.deepEqual(missing.payload.pool_created_at, { state: 'UNKNOWN', reason: 'MISSING' });
  assert.ok(missing.quarantined.every((field) => field.reason === 'UNIT_UNVERIFIED'), 'nothing to interpret, nothing quarantined');

  const bad = onlyPayload(edited((pair) => {
    pair['priceUsd'] = '1,234.5';
    (pair['liquidity'] as Record<string, unknown>)['usd'] = -5;
    (pair['quoteToken'] as Record<string, unknown>)['address'] = 'USDC';
    ((pair['txns'] as Record<string, Record<string, unknown>>)['h1'] as Record<string, unknown>)['buys'] = 1.5;
    pair['pairCreatedAt'] = 0;
    pair['dexId'] = 42;
    pair['labels'] = ['wp', 7];
  }));
  assert.deepEqual(bad.payload.price_usd, { state: 'UNKNOWN', reason: 'NOT_NUMERIC' });
  assert.deepEqual(bad.payload.liquidity_usd, { state: 'UNKNOWN', reason: 'NEGATIVE' });
  assert.deepEqual(bad.payload.quote_asset, { state: 'UNKNOWN', reason: 'INVALID_ADDRESS' }, 'a symbol is never an asset id');
  assert.deepEqual(bad.payload.txns.h1.buys, { state: 'UNKNOWN', reason: 'NOT_A_COUNT' });
  assert.deepEqual(bad.payload.pool_created_at, { state: 'UNKNOWN', reason: 'OUT_OF_RANGE' });
  assert.deepEqual(bad.payload.venue, { state: 'UNKNOWN', reason: 'INVALID_TEXT' });
  assert.deepEqual(bad.payload.venue_labels, ['wp']);

  const reasons = Object.fromEntries(
    bad.quarantined.filter((field) => field.reason !== 'UNIT_UNVERIFIED').map((field) => [field.fieldPath, [field.reason, field.rawValue]]),
  );
  assert.deepEqual(reasons, {
    '$[0].priceUsd': ['NOT_NUMERIC', '1,234.5'],
    '$[0].liquidity.usd': ['NEGATIVE', '-5'],
    '$[0].quoteToken.address': ['INVALID_ADDRESS', 'USDC'],
    '$[0].txns.h1.buys': ['NOT_A_COUNT', '1.5'],
    '$[0].pairCreatedAt': ['OUT_OF_RANGE', '0'],
    '$[0].dexId': ['INVALID_TEXT', '42'],
    '$[0].labels[1]': ['INVALID_LABEL', '7'],
  });
});

test('a pair that cannot be identified produces no event, only a quarantine record', () => {
  const cases: [string, (pair: Record<string, unknown>) => void, string, string][] = [
    ['other chain', (pair) => { pair['chainId'] = 'ethereum'; }, '$[0].chainId', 'UNSUPPORTED_CHAIN'],
    ['bad pool address', (pair) => { pair['pairAddress'] = '0xabc'; }, '$[0].pairAddress', 'INVALID_ADDRESS'],
    ['symbol as base token', (pair) => { (pair['baseToken'] as Record<string, unknown>)['address'] = 'SOL'; }, '$[0].baseToken.address', 'INVALID_ADDRESS'],
  ];
  for (const [name, edit, path, reason] of cases) {
    const result = dexscreenerTokensParser.parse(observation(edited(edit)));
    assert.equal(result.events.length, 0, name);
    assert.deepEqual(result.quarantined.map((field) => [field.fieldPath, field.reason]), [[path, reason]], name);
  }

  const notObject = dexscreenerTokensParser.parse(observation('[42]'));
  assert.deepEqual(notObject, { events: [], quarantined: [{ recordRef: '$[0]', fieldPath: '$[0]', rawValue: '42', reason: 'NOT_AN_OBJECT' }] });
});

test('the whole body is quarantined when it is not the documented array', () => {
  assert.deepEqual(dexscreenerTokensParser.parse(observation('{"pairs":[]}')).quarantined, [
    { recordRef: '$', fieldPath: '$', rawValue: null, reason: 'NOT_AN_ARRAY' },
  ]);
  assert.deepEqual(dexscreenerTokensParser.parse(observation('<html>busy</html>')).quarantined, [
    { recordRef: '$', fieldPath: '$', rawValue: '<html>busy</html>', reason: 'INVALID_JSON' },
  ]);
  assert.deepEqual(dexscreenerTokensParser.parse(observation('[]')), { events: [], quarantined: [] });
});

test('the same pool listed twice in one response is one event', () => {
  const pairs = JSON.parse(WSOL_TOKENS_RESPONSE.body) as unknown[];
  const result = dexscreenerTokensParser.parse(observation(JSON.stringify([pairs[0], pairs[0]])));
  assert.equal(result.events.length, 1);
});
