import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createPool } from '../db/pool.js';
import { capturingLogger, defer } from '../test-support/db.js';
import { requestLogLevel } from './request-log.js';
import { buildApiServer } from './server.js';

test('successful reads are debug, refusals and failures are not', () => {
  assert.equal(requestLogLevel('GET', 200, false), 'debug');
  assert.equal(requestLogLevel('HEAD', 304, false), 'debug');
  assert.equal(requestLogLevel('GET', 403, false), 'warn', 'Host or Origin refused');
  assert.equal(requestLogLevel('GET', 404, false), 'info');
  assert.equal(requestLogLevel('POST', 405, false), 'info');
  assert.equal(requestLogLevel('POST', 200, false), 'info', 'a write is never routine, even when it succeeds');
  assert.equal(requestLogLevel('POST', 403, false), 'warn');
  assert.equal(requestLogLevel('GET', 500, false), 'error');
  assert.equal(requestLogLevel('GET', 200, true), 'error', 'the response itself failed');
});

test('the API writes one line per request, at the level it deserves', async (t) => {
  const webRoot = await mkdtemp(path.join(os.tmpdir(), 'morrow-web-'));
  defer(t, () => rm(webRoot, { recursive: true, force: true }));
  await writeFile(path.join(webRoot, 'index.html'), '<!doctype html><title>Morrow</title>');
  // Never queried: no request below reaches the health endpoint.
  const pool = createPool('postgres://unused@127.0.0.1:1/unused', { applicationName: 'morrow-test' });
  defer(t, () => pool.end());

  const { logger, output } = capturingLogger((text) => text);
  const port = 8787;
  const app = await buildApiServer({ pool, logger, mode: 'OFF', version: 'test', port, webRoot });
  defer(t, () => app.close());
  app.get('/api/boom', async () => {
    throw new Error('boom');
  });

  const host = `127.0.0.1:${port}`;
  const requests = [
    { url: '/', headers: { host } },
    { url: '/', headers: { host: 'attacker.example' } },
    { url: '/', headers: { host, origin: 'https://attacker.example' } },
    { url: '/', method: 'POST' as const, headers: { host } },
    { url: '/api/unknown', headers: { host } },
    { url: '/api/boom', headers: { host } },
  ];
  for (const request of requests) await app.inject(request);

  const lines = output()
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.equal(lines.filter((line) => line['msg'] === 'incoming request').length, 0, 'no separate incoming line');
  const completed = lines.filter((line) => line['msg'] === 'request completed');
  // pino levels: 20 debug, 30 info, 40 warn, 50 error.
  assert.deepEqual(
    completed.map((line) => [(line['req'] as { method: string }).method, (line['res'] as { statusCode: number }).statusCode, line['level']]),
    [
      ['GET', 200, 20],
      ['GET', 403, 40],
      ['GET', 403, 40],
      ['POST', 405, 30],
      ['GET', 404, 30],
      ['GET', 500, 50],
    ],
  );
  const first = completed[0] as { req: Record<string, unknown>; responseTime: unknown };
  assert.equal(first.req['url'], '/');
  assert.equal(first.req['host'], host);
  assert.equal(typeof first.responseTime, 'number');
  // The failure keeps its stack trace, from Fastify's error handler.
  assert.ok(lines.some((line) => line['level'] === 50 && (line['err'] as { message?: string } | undefined)?.message === 'boom'));
});
