import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ProviderCredentials } from '../config/config.js';
import { QUOTA_POLICIES } from '../quota/quota-ledger.js';
import { classifyFetchError, classifyStatus, parseRetryAfterMs } from './client.js';
import { signOkxRequest } from './okx-signing.js';
import { SmoothRateLimiter } from './rate-limiter.js';
import { CAPABILITIES, PROVIDERS } from './registry.js';
import { nextHealth, shouldSuppress, type SourceHealth } from './source-health.js';
import { pathWithQuery, publicUrl, type RequestSpec } from './types.js';

const NOW = new Date('2026-10-05T12:00:00.000Z');
const later = (ms: number): Date => new Date(NOW.getTime() + ms);

const CREDENTIALS: ProviderCredentials = {
  jupiter: { apiKey: 'jupiter-key-0001' },
  helius: { apiKey: 'helius-key-0001' },
  okx: { apiKey: 'okx-key-00000001', secretKey: 'test-secret-key-0001', passphrase: 'okx-pass-00000001' },
};

test('HTTP status classification', () => {
  assert.equal(classifyStatus(200), 'OK');
  assert.equal(classifyStatus(204), 'OK');
  assert.equal(classifyStatus(401), 'UNAUTHORIZED');
  assert.equal(classifyStatus(403), 'UNAUTHORIZED');
  assert.equal(classifyStatus(402), 'PAYMENT_REQUIRED');
  assert.equal(classifyStatus(404), 'NOT_FOUND');
  assert.equal(classifyStatus(429), 'RATE_LIMITED');
  assert.equal(classifyStatus(400), 'CLIENT_ERROR');
  assert.equal(classifyStatus(302), 'CLIENT_ERROR', 'redirects are not followed');
  assert.equal(classifyStatus(500), 'SERVER_ERROR');
  assert.equal(classifyStatus(503), 'SERVER_ERROR');
});

test('a certificate that cannot be verified is TLS_UNTRUSTED, not a generic network error', () => {
  const intercepted = new TypeError('fetch failed', {
    cause: Object.assign(new Error('self-signed certificate in certificate chain'), { code: 'SELF_SIGNED_CERT_IN_CHAIN' }),
  });
  assert.deepEqual(classifyFetchError(intercepted), {
    outcome: 'TLS_UNTRUSTED',
    errorClass: 'SELF_SIGNED_CERT_IN_CHAIN',
    message: 'fetch failed: self-signed certificate in certificate chain',
  });
  const unknownIssuer = new TypeError('fetch failed', {
    cause: Object.assign(new Error('unable to get local issuer certificate'), { code: 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY' }),
  });
  assert.equal(classifyFetchError(unknownIssuer).outcome, 'TLS_UNTRUSTED');
});

test('timeouts and other failures are told apart', () => {
  const timeout = new DOMException('The operation was aborted due to timeout', 'TimeoutError');
  assert.equal(classifyFetchError(timeout).outcome, 'TIMEOUT');
  const connectTimeout = new TypeError('fetch failed', {
    cause: Object.assign(new Error('Connect Timeout Error'), { code: 'UND_ERR_CONNECT_TIMEOUT' }),
  });
  assert.equal(classifyFetchError(connectTimeout).outcome, 'TIMEOUT');
  const refused = new TypeError('fetch failed', { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) });
  assert.deepEqual(
    { outcome: classifyFetchError(refused).outcome, errorClass: classifyFetchError(refused).errorClass },
    { outcome: 'NETWORK_ERROR', errorClass: 'ECONNREFUSED' },
  );
  assert.equal(classifyFetchError('weird').outcome, 'NETWORK_ERROR');
});

test('Retry-After accepts seconds and HTTP dates', () => {
  assert.equal(parseRetryAfterMs('120', NOW), 120_000);
  assert.equal(parseRetryAfterMs(later(90_000).toUTCString(), NOW), 90_000);
  assert.equal(parseRetryAfterMs(later(-5_000).toUTCString(), NOW), 0, 'a past date means no wait');
  assert.equal(parseRetryAfterMs('soon', NOW), null);
  assert.equal(parseRetryAfterMs(null, NOW), null);
});

test('the rate limiter spaces a burst evenly and does not delay an idle caller', async () => {
  let clock = 1_000;
  const waits: number[] = [];
  const limiter = new SmoothRateLimiter(2_000, () => clock, async (ms) => {
    waits.push(ms);
  });

  await limiter.acquire();
  await limiter.acquire();
  await limiter.acquire();
  assert.deepEqual(waits, [2_000, 4_000], 'three calls at the same instant are sent at t, t+2s, t+4s');

  clock += 60_000;
  await limiter.acquire();
  assert.equal(waits.length, 2, 'no wait after a long idle period');
});

test('OKX signature matches an independently computed HMAC', () => {
  // Reference values produced with: printf '%s' "<prehash>" | openssl dgst -sha256 -hmac <key> -binary | base64
  assert.equal(
    signOkxRequest({
      timestamp: '2026-10-05T12:00:00.000Z',
      method: 'GET',
      requestPath: '/api/v6/dex/market/example?chainIndex=501&limit=5',
      body: '',
      secretKey: 'test-secret-key-0001',
    }),
    'I9J88flaY1VDhZvawIEFSTNf4RSGDjrkiB4cbqrI+8Q=',
  );
  assert.equal(
    signOkxRequest({
      timestamp: '2026-10-05T12:00:00.000Z',
      method: 'POST',
      requestPath: '/api/v6/example',
      body: '{"a":1}',
      secretKey: 'test-secret-key-0001',
    }),
    'Pkgk7AdIog6rdty09yi+yOJF5IKt30ruVGjNK7FGGB4=',
  );
});

test('query strings are sorted and encoded identically for storage and signing', () => {
  const spec: RequestSpec = { method: 'GET', origin: 'https://api.example.com', path: '/v1/x', query: { limit: '5', chainIndex: '501', q: 'a b&c' } };
  assert.equal(pathWithQuery(spec), '/v1/x?chainIndex=501&limit=5&q=a%20b%26c');
  assert.equal(publicUrl(spec), 'https://api.example.com/v1/x?chainIndex=501&limit=5&q=a%20b%26c');
  assert.equal(pathWithQuery({ method: 'GET', origin: 'https://api.example.com', path: '/v1/x' }), '/v1/x');
});

test('authorisation adds credentials at send time and never to the stored URL', () => {
  const spec: RequestSpec = { method: 'GET', origin: 'https://api.example.com', path: '/v1/x', query: { limit: '5' } };

  const helius = PROVIDERS.helius.authorize(spec, CREDENTIALS, NOW);
  assert.equal(helius?.url, 'https://api.example.com/v1/x?limit=5&api-key=helius-key-0001');
  assert.ok(!publicUrl(spec).includes('helius-key-0001'));

  const jupiter = PROVIDERS.jupiter.authorize(spec, CREDENTIALS, NOW);
  assert.equal(jupiter?.headers['x-api-key'], 'jupiter-key-0001');
  assert.equal(jupiter?.url, publicUrl(spec));

  const okx = PROVIDERS.okx.authorize(spec, CREDENTIALS, NOW);
  assert.equal(okx?.headers['OK-ACCESS-KEY'], 'okx-key-00000001');
  assert.equal(okx?.headers['OK-ACCESS-TIMESTAMP'], NOW.toISOString());
  assert.equal(okx?.headers['OK-ACCESS-PASSPHRASE'], 'okx-pass-00000001');
  assert.equal(
    okx?.headers['OK-ACCESS-SIGN'],
    signOkxRequest({ timestamp: NOW.toISOString(), method: 'GET', requestPath: '/v1/x?limit=5', body: '', secretKey: 'test-secret-key-0001' }),
  );
  assert.ok(!JSON.stringify(okx?.headers).includes('test-secret-key-0001'), 'the signing secret itself is never sent');
});

test('a provider without its credentials cannot be authorised', () => {
  const spec: RequestSpec = { method: 'GET', origin: 'https://api.example.com', path: '/' };
  assert.equal(PROVIDERS.jupiter.authorize(spec, {}, NOW), null);
  assert.equal(PROVIDERS.helius.authorize(spec, {}, NOW), null);
  assert.equal(PROVIDERS.okx.authorize(spec, {}, NOW), null);
  assert.notEqual(PROVIDERS.dexscreener.authorize(spec, {}, NOW), null, 'DEX Screener is keyless');
});

test('capability registry is internally consistent', () => {
  const names = new Set<string>();
  for (const capability of CAPABILITIES) {
    const key = `${capability.provider}/${capability.capability}`;
    assert.ok(!names.has(key), `duplicate capability ${key}`);
    names.add(key);

    const provider = PROVIDERS[capability.provider];
    assert.ok(provider, `unknown provider for ${key}`);
    assert.ok(capability.units >= 1);

    if (capability.probe) {
      assert.ok(capability.probe.origin.startsWith('https://'), `${key} must use https`);
      // A callable capability on a metered provider must be charged to a known bucket.
      if (provider.metered) {
        assert.ok(capability.quotaBucket !== null, `${key} is callable but has no quota bucket`);
      }
    }
    if (capability.quotaBucket !== null) {
      assert.ok(
        QUOTA_POLICIES.some((policy) => policy.provider === capability.provider && policy.bucket === capability.quotaBucket),
        `${key} names a bucket with no policy`,
      );
    }
  }
});

test('local budgets stop before the provider would', () => {
  for (const policy of QUOTA_POLICIES) {
    assert.ok(policy.warnAt < policy.hardStopAt, `${policy.provider}/${policy.bucket}`);
    assert.ok(policy.hardStopAt < policy.sourceLimit, `${policy.provider}/${policy.bucket}`);
  }
  const okx = QUOTA_POLICIES.filter((policy) => policy.provider === 'okx');
  assert.deepEqual(okx.map((policy) => [policy.bucket, policy.warnAt, policy.hardStopAt]), [
    ['basic', 70_000, 85_000],
    ['premium', 70_000, 85_000],
  ]);
});

// Source health transitions ---------------------------------------------------

function healthAfter(outcome: Parameters<typeof nextHealth>[1], previous: SourceHealth | null = null): SourceHealth {
  const next = nextHealth(previous, outcome, NOW);
  assert.ok(next, 'expected a health change');
  return next;
}

test('a rate limit blocks the capability for at least the Retry-After period', () => {
  const health = healthAfter({ outcome: 'RATE_LIMITED', httpStatus: 429, retryAfterMs: 120_000 });
  assert.equal(health.state, 'RATE_LIMITED');
  assert.equal(health.blockedUntil?.getTime(), later(120_000).getTime());
  for (const reason of ['scheduled', 'retry', 'manual', 'probe', 'backfill'] as const) {
    assert.equal(shouldSuppress(health, reason, later(119_000)), true, `${reason} must not jump a rate limit`);
    assert.equal(shouldSuppress(health, reason, later(120_000)), false, reason);
  }
});

test('a rate limit without Retry-After backs off, and repeated limits back off longer', () => {
  const first = healthAfter({ outcome: 'RATE_LIMITED', httpStatus: 429, retryAfterMs: null });
  assert.equal(first.blockedUntil?.getTime(), later(30_000).getTime());
  const second = healthAfter({ outcome: 'RATE_LIMITED', httpStatus: 429, retryAfterMs: null }, first);
  assert.equal(second.blockedUntil?.getTime(), later(60_000).getTime());
  const tiny = healthAfter({ outcome: 'RATE_LIMITED', httpStatus: 429, retryAfterMs: 1_000 });
  assert.equal(tiny.blockedUntil?.getTime(), later(30_000).getTime(), 'a short Retry-After does not lower our floor');
  const huge = healthAfter({ outcome: 'RATE_LIMITED', httpStatus: 429, retryAfterMs: 24 * 3_600_000 });
  assert.equal(huge.blockedUntil?.getTime(), later(15 * 60_000).getTime(), 'capped so the source is re-checked');
});

test('payment required is sticky: only an explicit probe re-tests it', () => {
  const health = healthAfter({ outcome: 'PAYMENT_REQUIRED', httpStatus: 402, retryAfterMs: null });
  assert.equal(health.state, 'PAYMENT_REQUIRED');
  assert.equal(health.blockedUntil, null);
  const muchLater = later(30 * 24 * 3_600_000);
  for (const reason of ['scheduled', 'retry', 'manual', 'backfill'] as const) {
    assert.equal(shouldSuppress(health, reason, muchLater), true, reason);
  }
  assert.equal(shouldSuppress(health, 'probe', muchLater), false);
});

test('unauthorised is sticky in the same way', () => {
  const health = healthAfter({ outcome: 'UNAUTHORIZED', httpStatus: 401, retryAfterMs: null });
  assert.equal(shouldSuppress(health, 'scheduled', later(3_600_000)), true);
  assert.equal(shouldSuppress(health, 'probe', later(3_600_000)), false);
});

test('failures back off exponentially up to five minutes, and one success clears them', () => {
  let health: SourceHealth | null = null;
  const delays: number[] = [];
  for (let i = 0; i < 8; i += 1) {
    health = healthAfter({ outcome: 'TLS_UNTRUSTED', httpStatus: null, retryAfterMs: null }, health);
    delays.push((health.blockedUntil?.getTime() ?? 0) - NOW.getTime());
  }
  assert.deepEqual(delays, [5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 300_000, 300_000]);
  assert.equal(health?.state, 'DOWN');
  assert.equal(health?.consecutiveFailures, 8);

  const recovered = healthAfter({ outcome: 'OK', httpStatus: 200, retryAfterMs: null }, health);
  assert.deepEqual(
    { state: recovered.state, failures: recovered.consecutiveFailures, blockedUntil: recovered.blockedUntil },
    { state: 'HEALTHY', failures: 0, blockedUntil: null },
  );
  assert.equal(recovered.lastSuccessAt?.getTime(), NOW.getTime());
  assert.equal(recovered.lastFailureAt?.getTime(), NOW.getTime(), 'the last failure time is kept as history');
});

test('a 404 shows the provider is reachable but is not counted as a success', () => {
  const health = healthAfter({ outcome: 'NOT_FOUND', httpStatus: 404, retryAfterMs: null });
  assert.equal(health.state, 'HEALTHY');
  assert.equal(health.lastOutcome, 'NOT_FOUND');
  assert.equal(health.lastSuccessAt, null);
});

test('outcomes where nothing was sent leave health untouched', () => {
  for (const outcome of ['QUOTA_HARD_STOP', 'SUPPRESSED', 'ENDPOINT_UNVERIFIED'] as const) {
    assert.equal(nextHealth(null, { outcome, httpStatus: null, retryAfterMs: null }, NOW), null, outcome);
  }
  assert.equal(shouldSuppress(null, 'scheduled', NOW), false, 'a never-seen source is tried');
});
