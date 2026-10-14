import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readJsonRpcEnvelope } from './jsonrpc-envelope.js';

const read = (body: unknown) => readJsonRpcEnvelope(Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)));
const error = (code: unknown, message?: unknown) => ({ jsonrpc: '2.0', id: 1, error: { code, ...(message !== undefined ? { message } : {}) } });

test('a response with a result is OK, a null result included', () => {
  assert.equal(read({ jsonrpc: '2.0', id: 1, result: 'ok' }), null);
  assert.equal(read({ jsonrpc: '2.0', id: 1, result: { context: { slot: 1 }, value: null } }), null);
  assert.equal(read({ jsonrpc: '2.0', id: 1, result: null }), null, 'null is a result');
  assert.equal(read([{ jsonrpc: '2.0', id: 1, result: 1 }, { jsonrpc: '2.0', id: 2, result: 2 }]), null);
});

test('errors are classified by the ranges the JSON-RPC 2.0 specification defines', () => {
  for (const code of [-32700, -32600, -32601, -32602]) assert.equal(read(error(code, 'x'))?.outcome, 'CLIENT_ERROR', String(code));
  assert.equal(read(error(-32603, 'x'))?.outcome, 'SERVER_ERROR', 'internal error');
  for (const code of [-32000, -32005, -32050, -32099]) assert.equal(read(error(code, 'x'))?.outcome, 'SERVER_ERROR', String(code));
  // Outside every defined range: never OK.
  for (const code of [-31999, -32100, -32429, 0, 1, 429, 500]) assert.equal(read(error(code, 'x'))?.outcome, 'CLIENT_ERROR', String(code));
});

test('the code and the provider message are kept', () => {
  assert.deepEqual(read(error(-32005, '  Node is behind by 42 slots ')), {
    outcome: 'SERVER_ERROR',
    errorClass: 'RPC_CODE_-32005',
    errorDetail: 'Node is behind by 42 slots',
  });
  assert.equal(read(error(-32601))?.errorDetail, 'no message');
  assert.equal(read(error(-32601, ''))?.errorDetail, 'no message');
});

test('a body that is not a well-formed JSON-RPC response is never OK', () => {
  assert.equal(read('not json')?.errorClass, 'RPC_INVALID_JSON');
  assert.equal(read({ jsonrpc: '2.0', id: 1 })?.errorClass, 'RPC_NO_RESULT');
  assert.equal(read('"just a string"')?.errorClass, 'RPC_NO_ENVELOPE');
  assert.equal(read('null')?.errorClass, 'RPC_NO_ENVELOPE');
  assert.equal(read([])?.errorClass, 'RPC_NO_RESULT');
  assert.equal(read(error('-32005', 'x'))?.errorClass, 'RPC_INVALID_ERROR', 'the code must be an integer');
  assert.equal(read(error(-32005.5, 'x'))?.errorClass, 'RPC_INVALID_ERROR');
  assert.equal(read({ jsonrpc: '2.0', id: 1, error: 'boom' })?.errorClass, 'RPC_INVALID_ERROR');
});

test('a batch fails on its first failing response', () => {
  const verdict = read([{ jsonrpc: '2.0', id: 1, result: 1 }, error(-32602, 'bad params'), error(-32603, 'later')]);
  assert.deepEqual(verdict, { outcome: 'CLIENT_ERROR', errorClass: 'RPC_CODE_-32602', errorDetail: 'bad params' });
  assert.equal(read([{ jsonrpc: '2.0', id: 1, result: 1 }, 7])?.errorClass, 'RPC_NO_ENVELOPE');
});

test('a result is only a success from a JSON-RPC 2.0 response', () => {
  assert.equal(read({ result: 'ok' })?.errorClass, 'RPC_VERSION', 'no jsonrpc member: an intermediary, not the server');
  assert.equal(read({ jsonrpc: '1.0', id: 1, result: 'ok' })?.errorClass, 'RPC_VERSION');
  assert.equal(read([{ jsonrpc: '2.0', id: 1, result: 1 }, { id: 2, result: 2 }])?.errorClass, 'RPC_VERSION');
  // An error is reported as the error it is, version or not.
  assert.equal(read({ error: { code: -32005, message: 'x' } })?.errorClass, 'RPC_CODE_-32005');
});

test('the answer must be to the request that was sent', () => {
  const answer = (body: unknown, request: unknown) =>
    readJsonRpcEnvelope(Buffer.from(JSON.stringify(body)), request === null ? null : JSON.stringify(request));
  const call = (id: unknown) => ({ jsonrpc: '2.0', id, method: 'getHealth' });
  const ok = (id: unknown) => ({ jsonrpc: '2.0', id, result: 'ok' });

  assert.equal(answer(ok(1), call(1)), null);
  assert.equal(answer(ok('a'), call('a')), null);
  assert.equal(answer(ok(2), call(1))?.errorClass, 'RPC_ID_MISMATCH');
  assert.equal(answer(ok('1'), call(1))?.errorClass, 'RPC_ID_MISMATCH', '"1" is not 1');
  assert.equal(answer({ jsonrpc: '2.0', result: 'ok' }, call(1))?.errorClass, 'RPC_ID_MISMATCH', 'no id at all');
  assert.equal(answer([ok(1)], call(1))?.errorClass, 'RPC_ID_MISMATCH', 'a batch for a single call');
  assert.equal(answer(ok(1), [call(1)])?.errorClass, 'RPC_ID_MISMATCH', 'a single answer to a batch');

  // A batch: every id once, in any order; notifications expect nothing.
  const notification = { jsonrpc: '2.0', method: 'ping' };
  assert.equal(answer([ok(2), ok(1)], [call(1), call(2), notification]), null);
  assert.equal(answer([ok(1)], [call(1), call(2)])?.errorClass, 'RPC_ID_MISMATCH', 'one call unanswered');
  assert.equal(answer([ok(1), ok(1)], [call(1), call(2)])?.errorClass, 'RPC_ID_MISMATCH', 'one call answered twice');

  // A parse error answers with a null id; it is still the error it reports.
  assert.equal(answer({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, call(1))?.errorClass, 'RPC_CODE_-32700');
  // A request that cannot be read cannot be matched against.
  assert.equal(readJsonRpcEnvelope(Buffer.from(JSON.stringify(ok(9))), 'not json'), null);
});
