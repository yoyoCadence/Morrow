import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canonicalJson } from './canonical-json.js';

test('key order does not change the text, at any depth', () => {
  assert.equal(canonicalJson({ b: 1, a: { d: [1, 2], c: null } }), '{"a":{"c":null,"d":[1,2]},"b":1}');
  assert.equal(canonicalJson({ a: { c: null, d: [1, 2] }, b: 1 }), canonicalJson({ b: 1, a: { d: [1, 2], c: null } }));
});

test('array order, types and strings are kept exactly', () => {
  assert.notEqual(canonicalJson([1, 2]), canonicalJson([2, 1]));
  assert.notEqual(canonicalJson({ a: '1' }), canonicalJson({ a: 1 }));
  assert.equal(canonicalJson({ s: 'é"\n' }), JSON.stringify({ s: 'é"\n' }));
});

test('undefined and toJSON behave as in JSON.stringify', () => {
  assert.equal(canonicalJson({ a: undefined, b: 2 }), '{"b":2}');
  assert.equal(canonicalJson([undefined]), '[null]');
  assert.equal(canonicalJson({ at: new Date('2026-10-13T00:00:00.000Z') }), '{"at":"2026-10-13T00:00:00.000Z"}');
});
