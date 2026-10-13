// Deliberately failing, to show that a failing test fails CI (RV-05).
// Removed in the next commit of the same pull request.
import assert from 'node:assert/strict';
import { test } from 'node:test';

test('CI canary: this test must fail', () => {
  assert.equal(1, 2);
});
