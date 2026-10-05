import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import net, { type AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { HealthReport, type EnabledMode } from '@morrow/core';
import { buildApiServer } from '../api/server.js';
import type { AppConfig } from '../config/config.js';
import { createPool } from '../db/pool.js';
import { enqueueJob, getJobState } from '../jobs/job-queue.js';
import { sleep, type JobHandler } from '../jobs/worker.js';
import { PROBE_JOB_KIND } from '../providers/probes.js';
import { requestStop, SessionConflictError } from '../session/run-session.js';
import { createTestDb, defer, silentLogger, type TestDb } from '../test-support/db.js';
import { APP_VERSION } from '../version.js';
import { defaultHandlers, SchemaNotCurrentError, startApiProcess, startWorkerProcess, type ProcessDeps } from './processes.js';

async function freshDb(t: TestContext, options: { migrate?: boolean } = {}): Promise<TestDb> {
  const db = await createTestDb(options);
  defer(t, () => db.close());
  return db;
}

async function freePort(): Promise<number> {
  const probe = net.createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

function deps(db: TestDb, mode: EnabledMode, apiPort = 8787): ProcessDeps {
  const config: AppConfig = { mode, databaseUrl: db.url, apiPort, logLevel: 'silent', credentials: {}, secretValues: [] };
  return { config, pool: db.pool, logger: silentLogger, redact: (text) => text, heartbeatIntervalMs: 25 };
}

interface Reply {
  readonly status: number;
  readonly headers: http.IncomingHttpHeaders;
  readonly body: string;
}

/** Plain HTTP request to loopback. Unlike fetch, this lets a test choose the Host header. */
function request(port: number, options: { path?: string; method?: string; headers?: Record<string, string> } = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: options.path ?? '/api/health', method: options.method ?? 'GET', headers: options.headers },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () =>
          resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks).toString() }),
        );
      },
    );
    req.on('error', reject);
    req.end();
  });
}

async function sessionStatus(db: TestDb, sessionId: string): Promise<string | undefined> {
  const result = await db.pool.query<{ status: string }>('SELECT status FROM run_sessions WHERE id = $1', [sessionId]);
  return result.rows[0]?.status;
}

test('the API starts, serves a valid health report on loopback, and stops cleanly', async (t) => {
  const db = await freshDb(t);
  const port = await freePort();
  const api = await startApiProcess(deps(db, 'PAPER', port));

  const reply = await request(port);
  assert.equal(reply.status, 200);
  assert.equal(reply.headers['cache-control'], 'no-store');
  const report = HealthReport.parse(JSON.parse(reply.body));
  assert.equal(report.mode, 'PAPER');
  assert.equal(report.live_trading_enabled, false);
  assert.equal(report.version, APP_VERSION);
  assert.deepEqual(report.database, { reachable: true, migrations_applied: report.database.migrations_applied, migrations_pending: 0, problem: null });
  assert.deepEqual(report.sessions.map((session) => [session.component, session.status, session.mode]), [['api', 'RUNNING', 'PAPER']]);
  assert.equal(report.status, 'ok');
  assert.equal(await sessionStatus(db, api.sessionId), 'RUNNING');

  await api.stop('test');
  await api.stopped;
  assert.equal(await sessionStatus(db, api.sessionId), 'STOPPED');
  await assert.rejects(request(port), /ECONNREFUSED/, 'the port is released');
});

test('the API refuses requests that do not address it directly', async (t) => {
  const db = await freshDb(t);
  const port = await freePort();
  const api = await startApiProcess(deps(db, 'RESEARCH', port));
  defer(t, () => api.stop('test'));

  // DNS rebinding: the browser thinks it is talking to another site.
  const rebinding = await request(port, { headers: { host: 'attacker.example' } });
  assert.deepEqual([rebinding.status, JSON.parse(rebinding.body)], [403, { error: 'HOST_NOT_ALLOWED' }]);
  const wrongPort = await request(port, { headers: { host: '127.0.0.1:1' } });
  assert.equal(wrongPort.status, 403);

  // Another site open in the operator's browser calling the local API.
  const crossSite = await request(port, { headers: { origin: 'https://attacker.example' } });
  assert.deepEqual([crossSite.status, JSON.parse(crossSite.body)], [403, { error: 'ORIGIN_NOT_ALLOWED' }]);

  assert.equal((await request(port, { headers: { host: `localhost:${port}` } })).status, 200);
  assert.equal((await request(port, { headers: { origin: `http://127.0.0.1:${port}` } })).status, 200);
});

test('nothing but reads is accepted, and security headers are set', async (t) => {
  const db = await freshDb(t);
  const port = await freePort();
  const api = await startApiProcess(deps(db, 'RESEARCH', port));
  defer(t, () => api.stop('test'));

  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    const reply = await request(port, { method });
    assert.deepEqual([reply.status, JSON.parse(reply.body)], [405, { error: 'METHOD_NOT_ALLOWED' }], method);
  }
  const unknown = await request(port, { path: '/api/trade' });
  assert.deepEqual([unknown.status, JSON.parse(unknown.body)], [404, { error: 'NOT_FOUND' }]);

  const ok = await request(port);
  assert.equal(ok.headers['x-content-type-options'], 'nosniff');
  assert.match(String(ok.headers['content-security-policy']), /default-src 'self'/);
});

test('the server listens on loopback only', async (t) => {
  const db = await freshDb(t);
  const port = await freePort();
  const api = await startApiProcess(deps(db, 'OFF', port));
  defer(t, () => api.stop('test'));

  const lanAddress = Object.values(os.networkInterfaces())
    .flat()
    .find((address) => address && address.family === 'IPv4' && !address.internal)?.address;
  if (!lanAddress) return t.skip('this machine has no non-loopback IPv4 address');

  await assert.rejects(
    new Promise((resolve, reject) => {
      const socket = net.connect({ host: lanAddress, port, timeout: 2_000 }, () => {
        socket.destroy();
        resolve(undefined);
      });
      socket.on('error', reject);
      socket.on('timeout', () => {
        socket.destroy();
        reject(new Error('timeout'));
      });
    }),
    'the API must not be reachable on a network interface',
  );
});

test('the dashboard build is served, with unknown pages falling back to it', async (t) => {
  const db = await freshDb(t);
  const webRoot = await mkdtemp(path.join(os.tmpdir(), 'morrow-web-'));
  defer(t, () => rm(webRoot, { recursive: true, force: true }));
  await writeFile(path.join(webRoot, 'index.html'), '<!doctype html><title>Morrow</title>');

  const port = 8787;
  const app = await buildApiServer({ pool: db.pool, logger: silentLogger, mode: 'OFF', version: 'test', port, webRoot });
  defer(t, () => app.close());
  const headers = { host: `127.0.0.1:${port}` };

  const index = await app.inject({ url: '/', headers });
  assert.equal(index.statusCode, 200);
  assert.match(index.body, /<title>Morrow<\/title>/);
  assert.match((await app.inject({ url: '/some/client/route', headers })).body, /<title>Morrow<\/title>/);
  assert.equal((await app.inject({ url: '/api/unknown', headers })).statusCode, 404, 'API paths never fall back to HTML');
  assert.equal((await app.inject({ url: '/api/health', headers })).statusCode, 200);

  const apiOnly = await buildApiServer({ pool: db.pool, logger: silentLogger, mode: 'OFF', version: 'test', port, webRoot: path.join(webRoot, 'absent') });
  defer(t, () => apiOnly.close());
  assert.equal((await apiOnly.inject({ url: '/', headers })).statusCode, 404);
});

test('health is degraded, with the reason, when something is wrong', async (t) => {
  const db = await freshDb(t);
  const port = 8787;
  const app = await buildApiServer({ pool: db.pool, logger: silentLogger, mode: 'RESEARCH', version: 'test', port });
  defer(t, () => app.close());
  const read = async (): Promise<HealthReport> =>
    HealthReport.parse((await app.inject({ url: '/api/health', headers: { host: `127.0.0.1:${port}` } })).json());

  assert.equal((await read()).status, 'ok');

  await db.pool.query(
    "INSERT INTO source_health (provider, capability, state, last_outcome) VALUES ('dexscreener', 'market.tokens', 'DOWN', 'TLS_UNTRUSTED')",
  );
  let report = await read();
  assert.equal(report.status, 'degraded');
  assert.deepEqual(report.sources.map((source) => [source.provider, source.state, source.last_outcome]), [['dexscreener', 'DOWN', 'TLS_UNTRUSTED']]);

  await db.pool.query("UPDATE source_health SET state = 'HEALTHY', last_outcome = 'OK'");
  assert.equal((await read()).status, 'ok');

  const { jobId } = await enqueueJob(db.pool, { kind: 'x' });
  await db.pool.query("UPDATE jobs SET status = 'dead', finished_at = clock_timestamp() WHERE id = $1", [jobId]);
  report = await read();
  assert.equal(report.status, 'degraded');
  assert.equal(report.jobs.dead, 1);
});

test('health says so when the schema is behind or the database is unreachable', async (t) => {
  const unmigrated = await freshDb(t, { migrate: false });
  const port = 8787;
  const headers = { host: `127.0.0.1:${port}` };

  const app = await buildApiServer({ pool: unmigrated.pool, logger: silentLogger, mode: 'OFF', version: 'test', port });
  defer(t, () => app.close());
  const behind = HealthReport.parse((await app.inject({ url: '/api/health', headers })).json());
  assert.equal(behind.status, 'degraded');
  assert.equal(behind.database.reachable, true);
  assert.ok(behind.database.migrations_pending >= 1);
  assert.match(behind.database.problem ?? '', /migrations are pending/);

  const deadPool = createPool('postgres://morrow:unusedPassw0rd@127.0.0.1:9/morrow', { applicationName: 'morrow-test-dead' });
  defer(t, () => deadPool.end());
  const down = await buildApiServer({ pool: deadPool, logger: silentLogger, mode: 'OFF', version: 'test', port });
  defer(t, () => down.close());
  const unreachable = HealthReport.parse((await down.inject({ url: '/api/health', headers })).json());
  assert.equal(unreachable.status, 'degraded');
  assert.equal(unreachable.database.reachable, false);
  assert.match(unreachable.database.problem ?? '', /database unreachable/);
  assert.doesNotMatch(unreachable.database.problem ?? '', /unusedPassw0rd/);
});

test('neither process starts against a database that has not been migrated', async (t) => {
  const db = await freshDb(t, { migrate: false });
  await assert.rejects(startApiProcess(deps(db, 'OFF', await freePort())), SchemaNotCurrentError);
  await assert.rejects(startWorkerProcess(deps(db, 'OFF')), SchemaNotCurrentError);
});

test('the worker runs queued jobs and stops cleanly', async (t) => {
  const db = await freshDb(t);
  const seen: unknown[] = [];
  const handlers = new Map<string, JobHandler>([['test.echo', async (job) => void seen.push(job.payload)]]);
  const worker = await startWorkerProcess({ ...deps(db, 'RESEARCH'), handlers });

  const { jobId } = await enqueueJob(db.pool, { kind: 'test.echo', payload: { hello: 'world' } });
  const deadline = Date.now() + 20_000;
  while ((await getJobState(db.pool, jobId))?.status !== 'succeeded' && Date.now() < deadline) await sleep(25);
  assert.equal((await getJobState(db.pool, jobId))?.status, 'succeeded');
  assert.deepEqual(seen, [{ hello: 'world' }]);

  await worker.stop('test');
  assert.equal(await sessionStatus(db, worker.sessionId), 'STOPPED');
});

test('a stop requested through the database shuts the worker down cleanly', async (t) => {
  const db = await freshDb(t);
  const worker = await startWorkerProcess({ ...deps(db, 'RESEARCH'), handlers: new Map() });

  assert.deepEqual(await requestStop(db.pool, ['worker']), ['worker']);
  await Promise.race([
    worker.stopped,
    sleep(20_000).then(() => {
      throw new Error('worker did not stop within 20s of the request');
    }),
  ]);
  assert.equal(await sessionStatus(db, worker.sessionId), 'STOPPED');

  // A clean stop leaves an OFFLINE gap for the next start, not an unclean one.
  const next = await startWorkerProcess({ ...deps(db, 'RESEARCH'), handlers: new Map() });
  defer(t, () => next.stop('test'));
  const gaps = await db.pool.query<{ kind: string }>('SELECT kind FROM session_gaps');
  assert.deepEqual(gaps.rows.map((row) => row.kind), ['OFFLINE']);
});

test('only one worker can run at a time', async (t) => {
  const db = await freshDb(t);
  const first = await startWorkerProcess({ ...deps(db, 'RESEARCH'), handlers: new Map() });
  defer(t, () => first.stop('test'));
  await assert.rejects(startWorkerProcess({ ...deps(db, 'RESEARCH'), handlers: new Map() }), SessionConflictError);
  assert.equal(await sessionStatus(db, first.sessionId), 'RUNNING');
});

test('OFF mode registers nothing that could contact a provider', async (t) => {
  const db = await freshDb(t);
  assert.deepEqual([...defaultHandlers(deps(db, 'OFF'), () => '1').keys()], []);
  assert.deepEqual([...defaultHandlers(deps(db, 'RESEARCH'), () => '1').keys()], [PROBE_JOB_KIND]);
  assert.deepEqual([...defaultHandlers(deps(db, 'PAPER'), () => '1').keys()], [PROBE_JOB_KIND]);

  // With no handler, a provider job simply waits; it is not run and not lost.
  const worker = await startWorkerProcess(deps(db, 'OFF'));
  defer(t, () => worker.stop('test'));
  const { jobId } = await enqueueJob(db.pool, { kind: PROBE_JOB_KIND });
  await sleep(300);
  assert.equal((await getJobState(db.pool, jobId))?.status, 'queued');
  const sent = await db.pool.query('SELECT 1 FROM raw_observations');
  assert.equal(sent.rowCount, 0);
});
