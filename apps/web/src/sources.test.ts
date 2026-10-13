import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SOURCE_STATES } from '@morrow/core';
import { bucketUsage, groupSources, groupSummary, sourceTone } from './sources.js';
import { quotaBucket, source } from './test-support/report.js';

test('only a source that should work and does not is bad', () => {
  const tones = Object.fromEntries(SOURCE_STATES.map((state) => [state, sourceTone(state)]));
  assert.deepEqual(tones, {
    HEALTHY: 'good',
    RATE_LIMITED: 'warn',
    PAYMENT_REQUIRED: 'bad',
    UNAUTHORIZED: 'bad',
    CREDENTIAL_MISSING: 'warn',
    DOWN: 'bad',
    REQUEST_REJECTED: 'warn',
  });
});

const sources = [
  source('dexscreener', 'market.tokens', 'HEALTHY'),
  source('helius', 'token.metadata', 'HEALTHY'),
  source('okx', 'market.candles', 'HEALTHY'),
  source('okx', 'token.price', 'CREDENTIAL_MISSING'),
  source('okx', 'token.holders', 'DOWN'),
  source('okx', '*', 'RATE_LIMITED'),
  source('okx', 'token.basic', 'RATE_LIMITED'),
];

test('the worst provider comes first, and inside it the worst rows', () => {
  const groups = groupSources(sources, false);
  assert.deepEqual(
    groups.map((group) => [group.provider, group.worst]),
    [
      ['okx', 'bad'],
      ['dexscreener', 'good'],
      ['helius', 'good'],
    ],
  );
  const okx = groups[0];
  assert.ok(okx);
  assert.deepEqual(
    okx.rows.map((row) => row.capability),
    ['token.holders', '*', 'token.basic', 'token.price', 'market.candles'],
    'bad, then the provider-wide row before other warnings, then by name',
  );
  assert.equal(okx.total, 4, 'the provider-wide row is not a capability');
  assert.equal(okx.problems, 3);
  assert.equal(okx.sharedLimit, true);
});

test('only issues hides healthy rows and groups with nothing else', () => {
  const groups = groupSources(sources, true);
  assert.deepEqual(groups.map((group) => group.provider), ['okx']);
  const okx = groups[0];
  assert.ok(okx);
  assert.deepEqual(okx.rows.map((row) => row.capability), ['token.holders', '*', 'token.basic', 'token.price']);
  assert.equal(okx.total, 4, 'counts are before the filter');
});

test('group summaries say how many capabilities have problems', () => {
  const [okx, dexscreener] = groupSources(sources, false);
  assert.ok(okx && dexscreener);
  assert.equal(groupSummary(dexscreener), '1 個功能，全部正常');
  assert.equal(groupSummary(okx), '4 個功能，整個供應商限流中，另有 3 個有問題');
  const [limitedOnly] = groupSources([source('okx', 'token.basic', 'HEALTHY'), source('okx', '*', 'RATE_LIMITED')], false);
  assert.ok(limitedOnly);
  assert.equal(groupSummary(limitedOnly), '1 個功能，整個供應商限流中');
  const [broken] = groupSources([source('okx', 'token.basic', 'DOWN')], false);
  assert.ok(broken);
  assert.equal(groupSummary(broken), '1 個功能，1 個有問題');
});

test('the bucket column shows the share of the hard stop, rounded down', () => {
  const quota = [quotaBucket('okx', 'basic', 24_650)];
  assert.equal(bucketUsage(source('okx', 'token.basic', 'HEALTHY', { quota_bucket: 'basic' }), quota), 'basic · 29%');
  assert.equal(bucketUsage(source('okx', 'token.price', 'HEALTHY', { quota_bucket: 'premium' }), quota), 'premium', 'no usage row yet');
  assert.equal(bucketUsage(source('dexscreener', 'market.tokens', 'HEALTHY'), quota), '—', 'no monthly allowance');
});
