import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ModeNotEnabledError } from '@morrow/core';
import { ConfigError, loadConfig } from './config.js';

const DB_PASSWORD = 'dbPassw0rdValue';
const base = { MORROW_DATABASE_URL: `postgres://morrow:${DB_PASSWORD}@127.0.0.1:54317/morrow` };

function problemsOf(env: NodeJS.ProcessEnv): readonly string[] {
  try {
    loadConfig(env);
  } catch (error) {
    assert.ok(error instanceof ConfigError, `expected ConfigError, got ${String(error)}`);
    return error.problems;
  }
  assert.fail('expected loadConfig to throw');
}

test('defaults are the safest values', () => {
  const config = loadConfig(base);
  assert.equal(config.mode, 'OFF');
  assert.equal(config.apiPort, 8787);
  assert.equal(config.logLevel, 'info');
  assert.deepEqual(config.credentials, {});
});

test('RESEARCH and PAPER are accepted', () => {
  assert.equal(loadConfig({ ...base, MORROW_MODE: 'RESEARCH' }).mode, 'RESEARCH');
  assert.equal(loadConfig({ ...base, MORROW_MODE: 'PAPER' }).mode, 'PAPER');
});

test('every live mode is refused at startup', () => {
  for (const mode of ['SHADOW', 'LIVE_CANARY', 'EXIT_ONLY', 'GUARDED_AUTO', 'FULL_AUTO']) {
    assert.throws(() => loadConfig({ ...base, MORROW_MODE: mode }), ModeNotEnabledError, mode);
  }
  assert.throws(() => loadConfig({ ...base, MORROW_MODE: 'LIVE' }), ModeNotEnabledError);
  assert.throws(() => loadConfig({ ...base, MORROW_MODE: 'paper' }), ModeNotEnabledError, 'modes are case-sensitive');
});

test('an unrecognised MORROW_ setting stops startup and is named', () => {
  const problems = problemsOf({ ...base, MORROW_SIGNER_PRIVATE_KEY: 'do-not-echo-this-value' });
  assert.equal(problems.length, 1);
  assert.match(problems[0] ?? '', /MORROW_SIGNER_PRIVATE_KEY/);
  assert.doesNotMatch(problems.join('\n'), /do-not-echo-this-value/);
});

test('a typo in a setting name is caught instead of falling back to a default', () => {
  assert.match(problemsOf({ ...base, MORROW_MOED: 'PAPER' }).join('\n'), /MORROW_MOED/);
});

test('the database URL is required and must be a postgres URL', () => {
  assert.match(problemsOf({}).join('\n'), /MORROW_DATABASE_URL: required but not set/);
  assert.match(problemsOf({ MORROW_DATABASE_URL: 'not a url' }).join('\n'), /not a valid URL/);
  assert.match(problemsOf({ MORROW_DATABASE_URL: 'mysql://u:p@h/db' }).join('\n'), /postgres:\/\//);
});

test('unrelated environment variables and empty values are ignored', () => {
  const config = loadConfig({ ...base, PATH: '/usr/bin', HOME: '/home/x', MORROW_HELIUS_API_KEY: '', MORROW_MODE: '' });
  assert.equal(config.mode, 'OFF');
  assert.equal(config.credentials.helius, undefined);
});

test('OKX credentials must be complete', () => {
  const problems = problemsOf({ ...base, MORROW_OKX_API_KEY: 'okx-key-00000001' });
  assert.match(problems.join('\n'), /must be set together/);

  const config = loadConfig({
    ...base,
    MORROW_OKX_API_KEY: 'okx-key-00000001',
    MORROW_OKX_SECRET_KEY: 'okx-secret-00000001',
    MORROW_OKX_PASSPHRASE: 'okx-pass-00000001',
  });
  assert.equal(config.credentials.okx?.apiKey, 'okx-key-00000001');
});

test('every secret is collected for redaction, including the database password', () => {
  const config = loadConfig({
    ...base,
    MORROW_TEST_DATABASE_URL: 'postgres://morrow:testPassw0rdValue@127.0.0.1:54317/morrow_test',
    MORROW_JUPITER_API_KEY: 'jupiter-key-0001',
    MORROW_HELIUS_API_KEY: 'helius-key-0001',
  });
  assert.deepEqual(
    [...config.secretValues].sort(),
    [DB_PASSWORD, 'helius-key-0001', 'jupiter-key-0001', 'testPassw0rdValue'].sort(),
  );
});

test('validation messages never contain a credential value', () => {
  const tooShort = 'zQ9!x';
  const problems = problemsOf({ ...base, MORROW_HELIUS_API_KEY: tooShort, MORROW_API_PORT: 'eighty' });
  assert.match(problems.join('\n'), /MORROW_HELIUS_API_KEY/);
  assert.match(problems.join('\n'), /MORROW_API_PORT/);
  assert.doesNotMatch(problems.join('\n'), /zQ9!x/);
});
