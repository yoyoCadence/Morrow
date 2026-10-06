import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PairSnapshot } from './market.js';

const unknown = { state: 'UNKNOWN', reason: 'MISSING' } as const;
const windows = <T>(value: T) => ({ m5: value, h1: value, h6: value, h24: value });

const valid = {
  pool_address: 'Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE',
  venue: { state: 'KNOWN', value: 'orca' },
  venue_labels: ['wp'],
  base_asset: 'solana:mainnet-beta:So11111111111111111111111111111111111111112',
  quote_asset: { state: 'KNOWN', value: 'solana:mainnet-beta:EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' },
  price_usd: { state: 'KNOWN', value: '120.78' },
  price_in_quote: unknown,
  liquidity_usd: unknown,
  volume_usd: windows({ state: 'UNKNOWN', reason: 'UNIT_UNVERIFIED' }),
  price_change: windows({ state: 'KNOWN', value: '-0.0084' }),
  txns: windows({ buys: { state: 'KNOWN', value: '151' }, sells: unknown }),
  fdv_usd: unknown,
  market_cap_usd: unknown,
  pool_created_at: { state: 'KNOWN', value: '2023-06-30T06:20:58.000Z' },
};

test('a pair snapshot with known and unknown fields is valid', () => {
  assert.deepEqual(PairSnapshot.parse(valid), valid);
});

test('a pair snapshot rejects what the contract forbids', () => {
  const invalid: Record<string, unknown> = {
    'a symbol as the base asset': { ...valid, base_asset: 'SOL' },
    'a symbol as the quote asset': { ...valid, quote_asset: { state: 'KNOWN', value: 'USDC' } },
    'a bare number instead of an Observed value': { ...valid, price_usd: '120.78' },
    'a float': { ...valid, price_usd: { state: 'KNOWN', value: 120.78 } },
    'an exponent': { ...valid, price_usd: { state: 'KNOWN', value: '1.2e2' } },
    'a fractional transaction count': { ...valid, txns: windows({ buys: { state: 'KNOWN', value: '1.5' }, sells: unknown }) },
    'UNKNOWN without a reason': { ...valid, fdv_usd: { state: 'UNKNOWN' } },
    'an invalid pool address': { ...valid, pool_address: '0xabc' },
    'a missing window': { ...valid, volume_usd: { m5: unknown, h1: unknown, h6: unknown } },
    'an unknown field': { ...valid, website: 'https://example.com' },
  };
  for (const [name, value] of Object.entries(invalid)) {
    assert.equal(PairSnapshot.safeParse(value).success, false, name);
  }
});
