import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AssetIdString, base58DecodedLength, formatAssetId, isSolanaAddress, parseAssetId, solanaAssetId } from './asset-id.js';

const WSOL = 'So11111111111111111111111111111111111111112';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const MINDS = '4SzWdVbXC7JiAtY5rH5MGc8HJPFAv6sSG97QEsjSpump';
const SYSTEM_PROGRAM = '11111111111111111111111111111111';

test('well-known Solana addresses decode to 32 bytes', () => {
  for (const address of [WSOL, USDC, MINDS, SYSTEM_PROGRAM]) {
    assert.equal(base58DecodedLength(address), 32, address);
    assert.equal(isSolanaAddress(address), true, address);
  }
});

test('non-addresses are rejected', () => {
  assert.equal(isSolanaAddress(''), false);
  assert.equal(isSolanaAddress('SOL'), false);
  assert.equal(isSolanaAddress(`${WSOL}1`), false, '33 bytes');
  assert.equal(isSolanaAddress(WSOL.slice(0, -1)), false, 'truncated');
  assert.equal(isSolanaAddress(WSOL.replace('S', '0')), false, '0 is not in the base58 alphabet');
  assert.equal(base58DecodedLength('O0Il'), null);
});

test('asset ids round-trip without changing the case of the mint', () => {
  const text = solanaAssetId(MINDS);
  assert.equal(text, `solana:mainnet-beta:${MINDS}`);
  assert.equal(formatAssetId(parseAssetId(text)), text);
  // Base58 is case-sensitive: a different case is a different address, so
  // parsing must never normalise it.
  assert.equal(parseAssetId(text).reference, MINDS);
  assert.throws(() => parseAssetId(`Solana:mainnet-beta:${MINDS}`));
});

test('a symbol or a partial id is never an asset id', () => {
  for (const bad of ['MINDS', 'solana:MINDS', `solana:${MINDS}`, `ethereum:mainnet:${MINDS}`, `solana:devnet:${MINDS}`, `solana:mainnet-beta:${MINDS}:extra`]) {
    assert.throws(() => parseAssetId(bad), bad);
    assert.equal(AssetIdString.safeParse(bad).success, false, bad);
  }
  assert.equal(AssetIdString.safeParse(solanaAssetId(USDC)).success, true);
});
