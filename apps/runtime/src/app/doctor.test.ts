import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { CREDENTIAL_VARIABLES } from '../config/config.js';
import { classifyHandshakeError, providerHosts } from '../providers/reachability.js';
import { CAPABILITIES, PROVIDERS } from '../providers/registry.js';
import {
  checkBackupDir,
  checkClockSkew,
  checkCredentials,
  checkHostResults,
  checkNodeVersion,
  checkToolVersion,
  formatDoctor,
  SUPPORTED_NODE,
} from './doctor.js';

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

test('the supported Node.js range is the one package.json declares', () => {
  const pkg = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as { engines: { node: string } };
  assert.equal(SUPPORTED_NODE.range, pkg.engines.node);
});

test('Node.js versions inside the range pass and the rest fail', () => {
  for (const version of ['24.19.0', 'v24.19.0', '24.19.1', '24.20.0', '24.99.99']) assert.equal(checkNodeVersion(version).status, 'ok', version);
  for (const version of ['24.18.9', '24.0.0', '22.12.0', '25.0.0', '26.1.0']) {
    const check = checkNodeVersion(version);
    assert.equal(check.status, 'fail', version);
    assert.match(check.detail, />=24\.19\.0 <25/);
  }
});

test('the credential settings listed are exactly the providers that cannot send without one', () => {
  const now = new Date();
  for (const provider of Object.keys(PROVIDERS)) {
    const capability = CAPABILITIES.find((entry) => entry.provider === provider && entry.probe !== null);
    assert.ok(capability?.probe, `${provider} has a confirmed endpoint`);
    const unauthenticated = PROVIDERS[provider as keyof typeof PROVIDERS].authorize(capability.probe, {}, now);
    assert.equal(unauthenticated === null, Object.hasOwn(CREDENTIAL_VARIABLES, provider), provider);
  }
});

test('credentials are reported by the names of their settings, never by value', () => {
  const missing = checkCredentials({ credentials: {} });
  assert.deepEqual(
    missing.map((check) => [check.name, check.status]),
    [
      ['Credentials: dexscreener', 'ok'],
      ['Credentials: helius', 'warn'],
      ['Credentials: jupiter', 'warn'],
      ['Credentials: okx', 'warn'],
    ],
  );
  assert.match(missing[3]?.detail ?? '', /MORROW_OKX_API_KEY, MORROW_OKX_SECRET_KEY, MORROW_OKX_PASSPHRASE/);

  const secrets = ['jupiter-secret-value-1', 'helius-secret-value-2', 'okx-key-value-3', 'okx-secret-value-4', 'okx-pass-value-5'];
  const set = checkCredentials({
    credentials: {
      jupiter: { apiKey: secrets[0] as string },
      helius: { apiKey: secrets[1] as string },
      okx: { apiKey: secrets[2] as string, secretKey: secrets[3] as string, passphrase: secrets[4] as string },
    },
  });
  assert.ok(set.every((check) => check.status === 'ok'));
  const printed = formatDoctor(set);
  for (const secret of secrets) assert.ok(!printed.includes(secret), 'a credential value was printed');
  assert.match(printed, /set \(MORROW_JUPITER_API_KEY\)/);
});

test('the backup folder must be set, absolute and outside the repository', () => {
  assert.equal(checkBackupDir({}).status, 'warn');
  assert.equal(checkBackupDir({ backupDir: 'relative/backups' }).status, 'fail');
  assert.equal(checkBackupDir({ backupDir: path.join(REPO_ROOT, 'backups') }).status, 'fail');
  const outside = checkBackupDir({ backupDir: path.join(os.tmpdir(), 'morrow-doctor-test-does-not-exist') });
  assert.deepEqual([outside.status, outside.detail], ['ok', 'set; created on the first backup']);
  assert.deepEqual(checkBackupDir({ backupDir: os.tmpdir() }).detail, 'set and exists');
});

test('clock skew: unknown is said as unknown, and the thresholds are those of health', () => {
  const unknown = checkClockSkew({ skew_ms: null, samples: 1 });
  assert.equal(unknown.status, 'info');
  assert.match(unknown.detail, /unknown: 1 recent provider responses/);
  assert.deepEqual([checkClockSkew({ skew_ms: 1_200, samples: 5 }).status, checkClockSkew({ skew_ms: 1_200, samples: 5 }).detail], ['ok', '+1.2 s']);
  assert.equal(checkClockSkew({ skew_ms: 5_000, samples: 5 }).status, 'ok');
  assert.equal(checkClockSkew({ skew_ms: -5_001, samples: 5 }).status, 'warn');
  assert.equal(checkClockSkew({ skew_ms: 30_000, samples: 5 }).status, 'warn');
  assert.equal(checkClockSkew({ skew_ms: -30_001, samples: 5 }).status, 'fail');
});

test('pg_dump and pg_restore must be on PATH and at least as new as the server', () => {
  assert.equal(checkToolVersion('pg_dump', null, 17).status, 'warn');
  assert.equal(checkToolVersion('pg_dump', 'pg_dump (PostgreSQL) 16.4', 17).status, 'warn');
  assert.equal(checkToolVersion('pg_dump', 'pg_dump (PostgreSQL) 17.6', 17).status, 'ok');
  assert.equal(checkToolVersion('pg_dump', 'pg_dump (PostgreSQL) 18.0', 17).status, 'ok');
  assert.equal(checkToolVersion('pg_dump', 'pg_dump (PostgreSQL) 16.4', null).status, 'ok', 'unknown server: nothing to compare');
});

test('a certificate that does not verify is TLS_UNTRUSTED, as it is for the worker', () => {
  const failure = (code: string) => Object.assign(new Error(code), { code });
  assert.equal(classifyHandshakeError(failure('SELF_SIGNED_CERT_IN_CHAIN')), 'TLS_UNTRUSTED');
  assert.equal(classifyHandshakeError(failure('UNABLE_TO_GET_ISSUER_CERT_LOCALLY')), 'TLS_UNTRUSTED');
  assert.equal(classifyHandshakeError(failure('ERR_TLS_CERT_ALTNAME_INVALID')), 'TLS_UNTRUSTED');
  assert.equal(classifyHandshakeError(failure('CERT_HAS_EXPIRED')), 'TLS_UNTRUSTED');
  assert.equal(classifyHandshakeError(failure('ECONNREFUSED')), 'CONNECT_FAILED');
  assert.equal(classifyHandshakeError(failure('ETIMEDOUT')), 'TIMEOUT');
  assert.equal(classifyHandshakeError(failure('ERR_SSL_WRONG_VERSION_NUMBER')), 'TLS_FAILED');
  assert.equal(classifyHandshakeError(new Error('no code')), 'TLS_FAILED');
});

test('every provider host is checked once', () => {
  assert.deepEqual(providerHosts(), ['api.dexscreener.com', 'api.jup.ag', 'mainnet.helius-rpc.com', 'web3.okx.com']);
});

test('host results and the summary read plainly', () => {
  const hosts = checkHostResults([
    { host: 'a.example', result: 'OK', code: null, durationMs: 42 },
    { host: 'b.example', result: 'TLS_UNTRUSTED', code: 'SELF_SIGNED_CERT_IN_CHAIN', durationMs: 30 },
  ]);
  assert.deepEqual(hosts[0], { status: 'ok', name: 'Host a.example', detail: 'TLS handshake in 42 ms' });
  assert.equal(hosts[1]?.status, 'fail');
  assert.match(hosts[1]?.detail ?? '', /^TLS_UNTRUSTED \(SELF_SIGNED_CERT_IN_CHAIN\): .*TLS interception/);

  const text = formatDoctor([...hosts, { status: 'warn', name: 'X', detail: 'y' }]);
  assert.match(text, /^ {2}OK {4}Host a\.example {2}TLS handshake in 42 ms$/m);
  assert.match(text, /^ {2}FAIL {2}Host b\.example {2}TLS_UNTRUSTED/m);
  assert.match(text, /\n1 failure, 1 warning\.$/);
});
