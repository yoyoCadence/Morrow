import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EVIDENCE_PAGE_DEFAULT, EVIDENCE_PAGE_MAX } from '@morrow/core';
import { createRedactor } from '../logging/redact.js';
import { bodyView, EvidenceQueryError, parseCursor, parseFilter, parseId, parseLimit, parseSubject } from './evidence.js';

const code = (work: () => unknown): string => {
  try {
    work();
  } catch (error) {
    if (error instanceof EvidenceQueryError) return error.error;
    throw error;
  }
  return 'accepted';
};

test('page sizes are whole numbers within the limit, with a default', () => {
  assert.equal(parseLimit(undefined), EVIDENCE_PAGE_DEFAULT);
  assert.equal(parseLimit('1'), 1);
  assert.equal(parseLimit(String(EVIDENCE_PAGE_MAX)), EVIDENCE_PAGE_MAX);
  for (const bad of ['0', String(EVIDENCE_PAGE_MAX + 1), '-1', '1.5', 'ten', '', ['1', '2']]) {
    assert.equal(code(() => parseLimit(bad)), 'INVALID_LIMIT', JSON.stringify(bad));
  }
});

test('cursors and ids are positive integers that fit a bigint', () => {
  assert.equal(parseCursor(undefined), null);
  assert.equal(parseCursor('9223372036854775807'), '9223372036854775807');
  assert.equal(parseId('42'), '42');
  for (const bad of ['0', '01', '-5', '9223372036854775808', '99999999999999999999', 'abc', ['1']]) {
    assert.equal(code(() => parseCursor(bad)), 'INVALID_CURSOR', JSON.stringify(bad));
    assert.equal(code(() => parseId(bad)), 'INVALID_ID', JSON.stringify(bad));
  }
  assert.equal(code(() => parseId(undefined)), 'INVALID_ID');
});

test('subjects follow the event contract, and filters are short strings', () => {
  assert.equal(parseSubject(undefined), null);
  assert.equal(parseSubject('solana:mainnet-beta:So11111111111111111111111111111111111111112'), 'solana:mainnet-beta:So11111111111111111111111111111111111111112');
  assert.equal(parseSubject('system:worker'), 'system:worker');
  for (const bad of ['WSOL', 'solana:mainnet-beta:not-a-mint', '', ['system:worker']]) {
    assert.equal(code(() => parseSubject(bad)), 'INVALID_SUBJECT', JSON.stringify(bad));
  }
  assert.equal(parseFilter(undefined), null);
  assert.equal(parseFilter('dexscreener'), 'dexscreener');
  for (const bad of ['', 'x'.repeat(129), ['a', 'b']]) assert.equal(code(() => parseFilter(bad)), 'INVALID_FILTER');
});

const plain = createRedactor([]);
const sha = 'a'.repeat(64);

test('a body is shown as text, cut without breaking a character', () => {
  const whole = bodyView(sha, 7, Buffer.from('{"a":1}'), plain);
  assert.deepEqual(whole, { sha256: sha, byte_length: 7, text: '{"a":1}', truncated: false, redacted: false });

  // "價" is three bytes in UTF-8; a cut after its first byte drops it instead of inventing a character.
  const cut = bodyView(sha, 100, Buffer.from('ab價', 'utf8').subarray(0, 3), plain);
  assert.equal(cut.text, 'ab');
  assert.equal(cut.truncated, true);
});

test('a body that is not UTF-8 is not shown as text', () => {
  assert.equal(bodyView(sha, 3, Buffer.from([0xff, 0xfe, 0x00]), plain).text, null);
  assert.equal(bodyView(sha, 2, Buffer.from([0xc3, 0x28]), plain).text, null, 'an invalid sequence inside the body');
});

test('anything credential-shaped in a body is replaced when it is shown, and the view says so', () => {
  const redact = createRedactor(['sk-live-0123456789']);
  const view = bodyView(sha, 60, Buffer.from('{"error":"bad key sk-live-0123456789","url":"/x?api-key=abc"}'), redact);
  assert.equal(view.text, '{"error":"bad key [REDACTED]","url":"/x?api-key=[REDACTED]"}');
  assert.equal(view.redacted, true);
});
