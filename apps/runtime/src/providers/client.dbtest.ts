import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import type { ProviderCredentials } from '../config/config.js';
import { readRawPayload } from '../db/raw-store.js';
import { createRedactor } from '../logging/redact.js';
import { periodStart } from '../quota/quota-ledger.js';
import { createTestDb, silentLogger, type TestDb } from '../test-support/db.js';
import { ProviderClient, type ProviderClientOptions } from './client.js';
import { runProbes } from './probes.js';
import { PROVIDERS } from './registry.js';
import type { CapabilityDefinition, ProviderDefinition, ProviderId, RequestSpec } from './types.js';

const HELIUS_KEY = 'helius-key-7f3a9c21';
const JUPITER_KEY = 'jupiter-key-55aa01';
const CREDENTIALS: ProviderCredentials = { helius: { apiKey: HELIUS_KEY }, jupiter: { apiKey: JUPITER_KEY } };
/** OKX's way of rejecting a signature: HTTP 200 with the error in the envelope. */
const ENVELOPE_ERROR = '{"code":"50113","msg":"Invalid Sign","data":[]}';

interface Hit {
  readonly method: string;
  readonly url: string;
  readonly headers: http.IncomingHttpHeaders;
}

let db: TestDb;
let server: http.Server;
let origin: string;
let closedOrigin: string;
const hits: Hit[] = [];
const hitsFor = (path: string): Hit[] => hits.filter((hit) => hit.url.split('?')[0] === path);

before(async () => {
  db = await createTestDb();

  server = http.createServer((request, response) => {
    hits.push({ method: request.method ?? '', url: request.url ?? '', headers: request.headers });
    const path = (request.url ?? '').split('?')[0];
    const send = (status: number, body: string, headers: Record<string, string> = {}): void => {
      response.writeHead(status, { 'content-type': 'application/json', ...headers });
      response.end(body);
    };
    request.resume();
    if (path === '/envelope-error') return send(200, ENVELOPE_ERROR);
    if (path === '/envelope-ok') return send(200, '{"code":"0","msg":"","data":[]}');
    if (path?.startsWith('/ok')) return send(200, '{"ok":true}');
    if (path === '/rate') return send(429, '{"error":"slow down"}', { 'retry-after': '120' });
    if (path === '/pay') return send(402, '{"error":"upgrade your plan"}');
    if (path === '/auth') return send(401, '{"error":"bad key"}');
    if (path === '/missing') return send(404, '{"error":"no such token"}');
    if (path === '/boom') return send(500, '{"error":"internal"}');
    if (path === '/big') return send(200, 'x'.repeat(5_000));
    if (path === '/redirect') return send(302, '', { location: '/ok-after-redirect' });
    if (path === '/slow') return void setTimeout(() => send(200, '{"late":true}'), 1_000);
    return send(400, '{"error":"unknown test route"}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  // A port that was just released: connecting to it is refused.
  const scratch = http.createServer();
  await new Promise<void>((resolve) => scratch.listen(0, '127.0.0.1', resolve));
  closedOrigin = `http://127.0.0.1:${(scratch.address() as AddressInfo).port}`;
  await new Promise((resolve) => scratch.close(resolve));
});

after(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await db.close();
});

const unpaced: Readonly<Record<ProviderId, ProviderDefinition>> = {
  jupiter: { ...PROVIDERS.jupiter, minIntervalMs: 0 },
  dexscreener: { ...PROVIDERS.dexscreener, minIntervalMs: 0 },
  okx: { ...PROVIDERS.okx, minIntervalMs: 0 },
  helius: { ...PROVIDERS.helius, minIntervalMs: 0 },
};

let sequence = 0;
/** A capability with a unique name, so each test has its own source-health row. */
function capability(provider: ProviderId, overrides: Partial<CapabilityDefinition> = {}): CapabilityDefinition {
  sequence += 1;
  return {
    provider,
    capability: `test.cap${sequence}`,
    quotaBucket: provider === 'helius' ? 'credits' : null,
    units: 1,
    probe: null,
    docVerified: true,
    note: 'test',
    ...overrides,
  };
}

/** Each client gets its own month far in the future, so quota counters never overlap between tests. */
function harness(options: Partial<ProviderClientOptions> = {}) {
  sequence += 1;
  let clock = new Date(Date.UTC(2040 + sequence, 0, 15));
  const client = new ProviderClient({
    pool: db.pool,
    logger: silentLogger,
    credentials: CREDENTIALS,
    redact: createRedactor([HELIUS_KEY, JUPITER_KEY]),
    providers: unpaced,
    now: () => clock,
    ...options,
  });
  return {
    client,
    now: () => clock,
    advance: (ms: number) => {
      clock = new Date(clock.getTime() + ms);
    },
  };
}

const get = (path: string, base = origin): RequestSpec => ({ method: 'GET', origin: base, path });

async function health(cap: CapabilityDefinition) {
  const result = await db.pool.query<{ state: string; last_outcome: string; consecutive_failures: number; blocked_until: Date | null }>(
    'SELECT state, last_outcome, consecutive_failures, blocked_until FROM source_health WHERE provider = $1 AND capability = $2',
    [cap.provider, cap.capability],
  );
  return result.rows[0];
}

async function rawRows(cap: CapabilityDefinition) {
  const result = await db.pool.query<{
    request_url: string; outcome: string; http_status: number | null; payload_sha256: string | null;
    error_class: string | null; error_detail: string | null; reason: string;
  }>(
    `SELECT request_url, outcome, http_status, payload_sha256, error_class, error_detail, reason
       FROM raw_observations WHERE provider = $1 AND capability = $2 ORDER BY id`,
    [cap.provider, cap.capability],
  );
  return result.rows;
}

async function quotaEvents(cap: CapabilityDefinition) {
  const result = await db.pool.query<{ decision: string; units: number }>(
    'SELECT decision, units FROM quota_events WHERE capability = $1 ORDER BY id',
    [cap.capability],
  );
  return result.rows;
}

test('a successful response is returned, stored as evidence, and marks the source healthy', async () => {
  const { client } = harness();
  const cap = capability('dexscreener');
  const result = await client.request({ capability: cap, spec: get('/ok'), reason: 'scheduled' });

  assert.equal(result.outcome, 'OK');
  assert.equal(result.httpStatus, 200);
  assert.equal(result.body?.toString(), '{"ok":true}');
  assert.ok(result.rawObservationId);

  const rows = await rawRows(cap);
  assert.equal(rows.length, 1);
  assert.deepEqual(
    { url: rows[0]?.request_url, outcome: rows[0]?.outcome, status: rows[0]?.http_status, reason: rows[0]?.reason },
    { url: `${origin}/ok`, outcome: 'OK', status: 200, reason: 'scheduled' },
  );
  assert.equal(rows[0]?.payload_sha256, result.payloadSha256);
  assert.equal((await readRawPayload(db.pool, result.payloadSha256 ?? ''))?.toString(), '{"ok":true}');
  assert.deepEqual(await health(cap), { state: 'HEALTHY', last_outcome: 'OK', consecutive_failures: 0, blocked_until: null });
});

test('a successful response that has a parser is stored together with its parse job', async () => {
  const { client } = harness();
  // The real capability name, because parsers are registered by it.
  const cap = capability('dexscreener', { capability: 'market.tokens' });
  const parseJobsFor = async (rawId: string | null) =>
    (await db.pool.query("SELECT 1 FROM jobs WHERE kind = 'raw.parse' AND payload->>'raw_observation_id' = $1", [rawId])).rowCount;

  const ok = await client.request({ capability: cap, spec: get('/ok'), reason: 'scheduled' });
  assert.equal(ok.outcome, 'OK');
  assert.equal(await parseJobsFor(ok.rawObservationId), 1);

  const failed = await client.request({ capability: cap, spec: get('/parse-error'), reason: 'scheduled' });
  assert.equal(failed.outcome, 'CLIENT_ERROR');
  assert.ok(failed.rawObservationId);
  assert.equal(await parseJobsFor(failed.rawObservationId), 0, 'an error response is evidence, not market data');

  const unparsed = await client.request({ capability: capability('jupiter'), spec: get('/ok'), reason: 'scheduled' });
  assert.equal(await parseJobsFor(unparsed.rawObservationId), 0, 'no parser, no job');
});

test('credentials reach the provider but are never stored', async () => {
  const { client } = harness();
  const helius = capability('helius');
  const jupiter = capability('jupiter');
  await client.request({ capability: helius, spec: { ...get('/ok-helius'), query: { commitment: 'finalized' } }, reason: 'scheduled' });
  await client.request({ capability: jupiter, spec: get('/ok-jupiter'), reason: 'scheduled' });

  assert.equal(hitsFor('/ok-helius')[0]?.url, `/ok-helius?commitment=finalized&api-key=${HELIUS_KEY}`);
  assert.equal(hitsFor('/ok-jupiter')[0]?.headers['x-api-key'], JUPITER_KEY);

  assert.equal((await rawRows(helius))[0]?.request_url, `${origin}/ok-helius?commitment=finalized`);
  for (const secret of [HELIUS_KEY, JUPITER_KEY]) {
    const leaked = await db.pool.query(
      `SELECT 1 FROM raw_observations
        WHERE request_url LIKE $1 OR coalesce(error_detail, '') LIKE $1 OR request_fingerprint LIKE $1`,
      [`%${secret}%`],
    );
    assert.equal(leaked.rowCount, 0, 'a credential was written to raw_observations');
  }
});

test('a rate limit stops all traffic to that capability until it expires', async () => {
  const { client, advance, now } = harness();
  const cap = capability('helius');

  const limited = await client.request({ capability: cap, spec: get('/rate'), reason: 'scheduled' });
  assert.equal(limited.outcome, 'RATE_LIMITED');
  const state = await health(cap);
  assert.equal(state?.state, 'RATE_LIMITED');
  assert.equal(state?.blocked_until?.getTime(), now().getTime() + 120_000, 'Retry-After: 120 is honoured');

  for (const reason of ['scheduled', 'retry', 'manual', 'probe'] as const) {
    const suppressed = await client.request({ capability: cap, spec: get('/rate'), reason });
    assert.equal(suppressed.outcome, 'SUPPRESSED', reason);
    assert.equal(suppressed.rawObservationId, null);
  }
  assert.equal(hitsFor('/rate').length, 1, 'nothing was sent while backing off');
  assert.equal((await rawRows(cap)).length, 1);
  assert.equal((await quotaEvents(cap)).length, 1, 'suppressed requests are not charged');

  advance(120_001);
  const afterwards = await client.request({ capability: cap, spec: get('/ok'), reason: 'scheduled' });
  assert.equal(afterwards.outcome, 'OK');
  assert.equal((await health(cap))?.state, 'HEALTHY');
});

test('payment required: the response is kept, nothing is paid, and only a probe re-tests it', async () => {
  const { client, advance } = harness();
  const cap = capability('dexscreener');

  const refused = await client.request({ capability: cap, spec: get('/pay'), reason: 'scheduled' });
  assert.equal(refused.outcome, 'PAYMENT_REQUIRED');
  assert.equal(refused.body?.toString(), '{"error":"upgrade your plan"}', 'the provider message is kept as evidence');
  assert.equal((await health(cap))?.state, 'PAYMENT_REQUIRED');

  advance(40 * 24 * 3_600_000);
  for (const reason of ['scheduled', 'retry', 'manual', 'backfill'] as const) {
    assert.equal((await client.request({ capability: cap, spec: get('/pay'), reason })).outcome, 'SUPPRESSED', reason);
  }
  assert.equal(hitsFor('/pay').length, 1, 'no automatic retries against a paywall');

  const probe = await client.request({ capability: cap, spec: get('/pay'), reason: 'probe' });
  assert.equal(probe.outcome, 'PAYMENT_REQUIRED');
  assert.equal(hitsFor('/pay').length, 2);
  for (const hit of hitsFor('/pay')) {
    assert.equal(hit.headers['x-payment'], undefined, 'no payment header is ever attached');
  }
});

test('an OKX error inside an HTTP 200 is classified by its code, not reported as OK', async () => {
  const okx = { apiKey: 'okx-key-3c9e1d77', secretKey: 'okx-secret-8b20f4aa', passphrase: 'okx-pass-61d0c2e9' };
  const { client } = harness({
    credentials: { ...CREDENTIALS, okx },
    redact: createRedactor([HELIUS_KEY, JUPITER_KEY, okx.apiKey, okx.secretKey, okx.passphrase]),
  });

  const rejected = capability('okx', { quotaBucket: 'basic' });
  const result = await client.request({ capability: rejected, spec: get('/envelope-error'), reason: 'probe' });
  assert.equal(result.outcome, 'UNAUTHORIZED');
  assert.equal(result.httpStatus, 200);
  assert.equal(result.detail, 'OKX_CODE_50113');
  assert.equal(result.body?.toString(), ENVELOPE_ERROR, 'the response is kept as evidence');

  const [row] = await rawRows(rejected);
  assert.deepEqual(
    { outcome: row?.outcome, status: row?.http_status, errorClass: row?.error_class, errorDetail: row?.error_detail },
    { outcome: 'UNAUTHORIZED', status: 200, errorClass: 'OKX_CODE_50113', errorDetail: 'Invalid Sign' },
  );
  assert.equal((await health(rejected))?.state, 'UNAUTHORIZED', 'it needs a person, like an HTTP 401');

  const accepted = capability('okx', { quotaBucket: 'basic' });
  assert.equal((await client.request({ capability: accepted, spec: get('/envelope-ok'), reason: 'probe' })).outcome, 'OK');

  // Providers without an envelope are judged by the HTTP status alone.
  const plain = capability('dexscreener');
  assert.equal((await client.request({ capability: plain, spec: get('/envelope-error'), reason: 'probe' })).outcome, 'OK');
});

test('rejected credentials are not retried automatically', async () => {
  const { client } = harness();
  const cap = capability('dexscreener');
  assert.equal((await client.request({ capability: cap, spec: get('/auth'), reason: 'scheduled' })).outcome, 'UNAUTHORIZED');
  assert.equal((await client.request({ capability: cap, spec: get('/auth'), reason: 'scheduled' })).outcome, 'SUPPRESSED');
  assert.equal(hitsFor('/auth').length, 1);
  assert.equal((await health(cap))?.state, 'UNAUTHORIZED');
});

test('a server error marks the source down and backs off', async () => {
  const { client, advance } = harness();
  const cap = capability('dexscreener');

  assert.equal((await client.request({ capability: cap, spec: get('/boom'), reason: 'scheduled' })).outcome, 'SERVER_ERROR');
  assert.deepEqual(
    { state: (await health(cap))?.state, failures: (await health(cap))?.consecutive_failures },
    { state: 'DOWN', failures: 1 },
  );
  assert.equal((await client.request({ capability: cap, spec: get('/boom'), reason: 'retry' })).outcome, 'SUPPRESSED');

  advance(5_001);
  assert.equal((await client.request({ capability: cap, spec: get('/boom'), reason: 'retry' })).outcome, 'SERVER_ERROR');
  assert.equal((await health(cap))?.consecutive_failures, 2);
  assert.equal(hitsFor('/boom').length, 2);
});

test('a 404 is an answer about the request, not an outage', async () => {
  const { client } = harness();
  const cap = capability('dexscreener');
  assert.equal((await client.request({ capability: cap, spec: get('/missing'), reason: 'scheduled' })).outcome, 'NOT_FOUND');
  assert.equal((await health(cap))?.state, 'HEALTHY');
  assert.equal((await client.request({ capability: cap, spec: get('/ok'), reason: 'scheduled' })).outcome, 'OK');
});

test('a slow provider times out and the failure is stored without a payload', async () => {
  const { client } = harness({ timeoutMs: 100 });
  const cap = capability('dexscreener');
  const result = await client.request({ capability: cap, spec: get('/slow'), reason: 'scheduled' });

  assert.equal(result.outcome, 'TIMEOUT');
  assert.equal(result.body, null);
  const rows = await rawRows(cap);
  assert.deepEqual(
    { outcome: rows[0]?.outcome, status: rows[0]?.http_status, payload: rows[0]?.payload_sha256 },
    { outcome: 'TIMEOUT', status: null, payload: null },
  );
  assert.ok(rows[0]?.error_class);
  assert.equal((await health(cap))?.state, 'DOWN');
});

test('an unreachable provider is a network error', async () => {
  const { client } = harness();
  const cap = capability('dexscreener');
  const result = await client.request({ capability: cap, spec: get('/ok', closedOrigin), reason: 'scheduled' });
  assert.equal(result.outcome, 'NETWORK_ERROR');
  assert.equal((await rawRows(cap))[0]?.error_class, 'ECONNREFUSED');
});

test('redirects are not followed', async () => {
  const { client } = harness();
  const cap = capability('jupiter');
  const result = await client.request({ capability: cap, spec: get('/redirect'), reason: 'scheduled' });
  assert.equal(result.outcome, 'CLIENT_ERROR');
  assert.equal(result.httpStatus, 302);
  assert.equal(hitsFor('/ok-after-redirect').length, 0, 'the credential header did not travel to the redirect target');
});

test('an oversized response is refused and not stored', async () => {
  const { client } = harness({ maxBodyBytes: 1_000 });
  const cap = capability('dexscreener');
  const result = await client.request({ capability: cap, spec: get('/big'), reason: 'scheduled' });
  assert.equal(result.outcome, 'RESPONSE_TOO_LARGE');
  assert.equal((await rawRows(cap))[0]?.payload_sha256, null);
});

test('without credentials nothing is sent and nothing is charged', async () => {
  const { client } = harness({ credentials: {} });
  const cap = capability('helius');
  const result = await client.request({ capability: cap, spec: get('/ok-no-credentials'), reason: 'scheduled' });

  assert.equal(result.outcome, 'CREDENTIAL_MISSING');
  assert.equal(hitsFor('/ok-no-credentials').length, 0);
  assert.equal((await rawRows(cap)).length, 0);
  assert.equal((await quotaEvents(cap)).length, 0);
  assert.equal((await health(cap))?.state, 'CREDENTIAL_MISSING');
});

test('metered calls are charged, and the hard stop prevents the request from being sent', async () => {
  const { client, now } = harness();
  const cap = capability('helius', { units: 3 });
  await db.pool.query("INSERT INTO quota_counters (provider, bucket, period_start, used) VALUES ('helius', 'credits', $1, 849994)", [
    periodStart(now()),
  ]);

  assert.equal((await client.request({ capability: cap, spec: get('/ok-metered'), reason: 'scheduled' })).outcome, 'OK');
  assert.equal((await client.request({ capability: cap, spec: get('/ok-metered'), reason: 'retry' })).outcome, 'OK');
  const stopped = await client.request({ capability: cap, spec: get('/ok-metered'), reason: 'manual' });

  assert.equal(stopped.outcome, 'QUOTA_HARD_STOP');
  assert.equal(stopped.rawObservationId, null);
  assert.equal(hitsFor('/ok-metered').length, 2, 'the third request never left');
  assert.deepEqual(await quotaEvents(cap), [
    { decision: 'ALLOW_WARN', units: 3 },
    { decision: 'ALLOW_WARN', units: 3 },
    { decision: 'DENY_HARD_STOP', units: 3 },
  ]);
  const used = await db.pool.query<{ used: string }>(
    "SELECT used FROM quota_counters WHERE provider = 'helius' AND bucket = 'credits' AND period_start = $1",
    [periodStart(now())],
  );
  assert.equal(Number(used.rows[0]?.used), 850_000);
  assert.equal((await health(cap))?.state, 'HEALTHY', 'running out of budget says nothing about the provider');
});

test('a failed request is still charged', async () => {
  const { client } = harness();
  const cap = capability('helius');
  await client.request({ capability: cap, spec: get('/boom'), reason: 'scheduled' });
  assert.deepEqual(await quotaEvents(cap), [{ decision: 'ALLOW', units: 1 }]);
});

test('a metered provider cannot be called without naming a bucket', async () => {
  const { client } = harness();
  const cap = capability('helius', { quotaBucket: null });
  await assert.rejects(client.request({ capability: cap, spec: get('/ok-unbucketed'), reason: 'scheduled' }), /names no quota bucket/);
  assert.equal(hitsFor('/ok-unbucketed').length, 0);
});

test('requests to one provider are spaced by its minimum interval', async () => {
  const waits: number[] = [];
  const { client } = harness({
    providers: { ...unpaced, dexscreener: { ...PROVIDERS.dexscreener, minIntervalMs: 2_000 } },
    sleep: async (ms) => void waits.push(ms),
  });
  const cap = capability('dexscreener');
  const other = capability('jupiter');
  await client.request({ capability: cap, spec: get('/ok'), reason: 'scheduled' });
  await client.request({ capability: cap, spec: get('/ok'), reason: 'scheduled' });
  await client.request({ capability: cap, spec: get('/ok'), reason: 'scheduled' });
  await client.request({ capability: other, spec: get('/ok'), reason: 'scheduled' });
  assert.deepEqual(waits, [2_000, 4_000], 'the second and third wait; a different provider does not');
});

test('secrets in a transport error message are removed before it is stored', async () => {
  const { client } = harness({
    fetch: async () => {
      throw new TypeError('fetch failed', {
        cause: Object.assign(new Error(`socket closed for https://rpc.example/?api-key=${HELIUS_KEY}`), { code: 'ECONNRESET' }),
      });
    },
  });
  const cap = capability('helius');
  const result = await client.request({ capability: cap, spec: get('/ok'), reason: 'scheduled' });
  assert.equal(result.outcome, 'NETWORK_ERROR');
  const detail = (await rawRows(cap))[0]?.error_detail ?? '';
  assert.ok(!detail.includes(HELIUS_KEY));
  assert.match(detail, /\[REDACTED\]/);
});

test('probes record what each capability returned and skip unconfirmed endpoints', async () => {
  const { client } = harness({ credentials: { jupiter: CREDENTIALS.jupiter } });
  const reachable = capability('dexscreener', { probe: get('/ok-probe'), docVerified: true });
  const paywalled = capability('jupiter', { probe: get('/pay'), docVerified: false, note: 'unverified endpoint' });
  const unconfirmed = capability('okx', { probe: null, docVerified: false, note: 'no endpoint yet' });
  const noCredentials = capability('helius', { probe: get('/ok-probe-helius') });

  const paywallHitsBefore = hitsFor('/pay').length;
  const records = await runProbes({ pool: db.pool, client, capabilities: [reachable, paywalled, unconfirmed, noCredentials] });

  assert.deepEqual(
    records.map((record) => [record.provider, record.outcome, record.httpStatus]),
    [
      ['dexscreener', 'OK', 200],
      ['jupiter', 'PAYMENT_REQUIRED', 402],
      ['okx', 'ENDPOINT_UNVERIFIED', null],
      ['helius', 'CREDENTIAL_MISSING', null],
    ],
  );
  assert.equal(hitsFor('/ok-probe').length, 1);
  assert.equal(hitsFor('/pay').length, paywallHitsBefore + 1);
  assert.equal(hitsFor('/ok-probe-helius').length, 0);
  assert.match(records[1]?.detail ?? '', /unverified endpoint/, 'an unverified definition is flagged in the result');

  const stored = await db.pool.query<{ capability: string; outcome: string; doc_verified: boolean; raw_observation_id: string | null }>(
    'SELECT capability, outcome, doc_verified, raw_observation_id FROM provider_probes WHERE capability = ANY($1::text[]) ORDER BY id',
    [[reachable, paywalled, unconfirmed, noCredentials].map((cap) => cap.capability)],
  );
  assert.deepEqual(stored.rows.map((row) => row.outcome), ['OK', 'PAYMENT_REQUIRED', 'ENDPOINT_UNVERIFIED', 'CREDENTIAL_MISSING']);
  assert.deepEqual(stored.rows.map((row) => row.raw_observation_id !== null), [true, true, false, false]);
  assert.equal((await rawRows(reachable))[0]?.reason, 'probe');

  const audit = await db.pool.query<{ detail: { outcomes: Record<string, number> } }>(
    "SELECT detail FROM audit_log WHERE action = 'provider.probe.completed' ORDER BY id DESC LIMIT 1",
  );
  assert.deepEqual(audit.rows[0]?.detail.outcomes, { OK: 1, PAYMENT_REQUIRED: 1, ENDPOINT_UNVERIFIED: 1, CREDENTIAL_MISSING: 1 });
});
