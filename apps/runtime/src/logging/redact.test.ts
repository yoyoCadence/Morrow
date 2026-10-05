import assert from 'node:assert/strict';
import { test } from 'node:test';
import { capturingLogger } from '../test-support/db.js';
import { createRedactor, REDACTED } from './redact.js';

const API_KEY = 'helius-key-7f3a9c21';
const AWKWARD = 'p@ss"word\\with/odd&chars';
const DB_URL = 'postgres://morrow:dbPassw0rdValue@127.0.0.1:54317/morrow';

test('known secret values are removed wherever they appear', () => {
  const redact = createRedactor([API_KEY]);
  assert.equal(redact(`key is ${API_KEY}!`), `key is ${REDACTED}!`);
  assert.equal(redact(`${API_KEY}${API_KEY}`), `${REDACTED}${REDACTED}`);
  assert.equal(redact('nothing secret here'), 'nothing secret here');
});

test('JSON-escaped and URL-encoded forms of a secret are removed too', () => {
  const redact = createRedactor([AWKWARD]);
  assert.ok(!redact(JSON.stringify({ value: AWKWARD })).includes('p@ss'));
  assert.ok(!redact(`https://x.example/?q=${encodeURIComponent(AWKWARD)}`).includes('p%40ss'));
});

test('credential-shaped text is removed even when the value was never registered', () => {
  const redact = createRedactor([]);
  assert.equal(redact(DB_URL), `postgres://morrow:${REDACTED}@127.0.0.1:54317/morrow`);
  assert.equal(
    redact('GET https://mainnet.helius-rpc.com/?api-key=abc123&commitment=finalized'),
    `GET https://mainnet.helius-rpc.com/?api-key=${REDACTED}&commitment=finalized`,
  );
  assert.equal(redact('https://x.example/a?token=t0k3n'), `https://x.example/a?token=${REDACTED}`);
});

test('a very short secret is not value-matched, so ordinary words survive', () => {
  const redact = createRedactor(['dev']);
  assert.equal(redact('developer mode'), 'developer mode');
  assert.equal(redact('postgres://u:dev@localhost/db'), `postgres://u:${REDACTED}@localhost/db`);
});

test('a secret containing another is removed whole', () => {
  const redact = createRedactor(['abcdef', 'abcdef-extended']);
  assert.equal(redact('value=abcdef-extended;'), `value=${REDACTED};`);
});

test('the logger never writes a secret, whatever shape it arrives in', () => {
  const redact = createRedactor([API_KEY, 'dbPassw0rdValue']);
  const { logger, output } = capturingLogger(redact);

  logger.info(`plain message with ${API_KEY}`);
  logger.info({ nested: { deep: [API_KEY] } }, 'nested object');
  logger.error({ err: new Error(`request to https://rpc.example/?api-key=${API_KEY} failed`) }, 'error with secret');
  logger.warn({ url: DB_URL }, 'connection string');
  logger.info({ headers: { authorization: 'Bearer some-other-token' } }, 'auth header');
  logger.child({ context: API_KEY }).info('child binding');

  const text = output();
  assert.equal(text.split('\n').filter(Boolean).length, 6, 'every line was written');
  assert.ok(!text.includes(API_KEY), 'API key leaked');
  assert.ok(!text.includes('dbPassw0rdValue'), 'database password leaked');
  assert.ok(!text.includes('some-other-token'), 'authorization header leaked');
  assert.ok(text.includes(REDACTED));
  // Redaction must leave each line valid JSON.
  for (const line of text.split('\n').filter(Boolean)) JSON.parse(line);
});
