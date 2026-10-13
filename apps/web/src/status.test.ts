import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { HEALTH_LEVELS, type HealthReport } from '@morrow/core';
import { faviconPath, indicators, LEVELS, type PageState, pageTitle } from './status.js';
import { healthReport, quotaBucket, REPORT_MS, source, workerSession } from './test-support/report.js';

const read = (report: HealthReport) => indicators(report, REPORT_MS).map(({ key, tone, text }) => `${key} ${tone} ${text}`);
const indicator = (report: HealthReport, key: string) => read(report).find((line) => line.startsWith(`${key} `));

const workerNotRunning = {
  severity: 'degraded',
  code: 'WORKER_NOT_RUNNING',
  subject: 'worker',
  detail: 'No worker is running in RESEARCH mode.',
} as const;

test('the status bar reads worker, sources, quota and dead jobs, in that order', () => {
  const report = healthReport({
    sessions: [workerSession('LIVE', '2026-10-14T02:59:48.000Z')],
    sources: [source('dexscreener', 'market.tokens', 'HEALTHY')],
    quota: [quotaBucket('okx', 'basic', 1_000)],
  });
  assert.deepEqual(read(report), [
    'worker good worker 心跳 12 秒前',
    'sources good 來源 正常 1/1',
    'quota good 額度 最高 1%（okx/basic）',
    'jobs good 失敗終止的工作 0',
  ]);
});

test('a worker that is not running is a problem only when the report says it is needed', () => {
  assert.equal(indicator(healthReport({ sessions: [workerSession('STALE')] }), 'worker'), 'worker bad worker 心跳中斷');
  assert.equal(indicator(healthReport(), 'worker'), 'worker neutral worker 未執行', 'OFF mode needs no worker');
  assert.equal(indicator(healthReport({ sessions: [workerSession('ENDED')] }), 'worker'), 'worker neutral worker 未執行');
  assert.equal(
    indicator(healthReport({ status: 'degraded', findings: [workerNotRunning] }), 'worker'),
    'worker bad worker 未執行',
  );
});

test('sources count capabilities, not the provider-wide row, and name a shared limit', () => {
  assert.equal(indicator(healthReport(), 'sources'), 'sources neutral 來源 尚未請求');
  const rejected = healthReport({
    sources: [source('dexscreener', 'market.tokens', 'HEALTHY'), source('okx', 'token.holders', 'REQUEST_REJECTED')],
  });
  assert.equal(indicator(rejected, 'sources'), 'sources warn 來源 正常 1/2');
  const down = healthReport({ sources: [source('dexscreener', 'market.tokens', 'DOWN')] });
  assert.equal(indicator(down, 'sources'), 'sources bad 來源 正常 0/1');
  const shared = healthReport({
    sources: [source('okx', 'token.holders', 'HEALTHY'), source('okx', '*', 'RATE_LIMITED')],
  });
  assert.equal(indicator(shared, 'sources'), 'sources warn 來源 正常 1/1 · okx 共用限流中', 'healthy rows are still held back');
});

test('quota shows the bucket closest to its hard stop, rounded down', () => {
  assert.equal(indicator(healthReport(), 'quota'), 'quota neutral 額度 —');
  const two = healthReport({ quota: [quotaBucket('okx', 'basic', 24_650), quotaBucket('okx', 'premium', 1_000)] });
  assert.equal(indicator(two, 'quota'), 'quota good 額度 最高 29%（okx/basic）', 'exactly 29%, not 28.999…');
  assert.equal(indicator(healthReport({ quota: [quotaBucket('okx', 'basic', 84_999)] }), 'quota'), 'quota warn 額度 最高 99%（okx/basic）');
  assert.equal(indicator(healthReport({ quota: [quotaBucket('okx', 'basic', 85_000)] }), 'quota'), 'quota bad 額度 最高 100%（okx/basic）');
});

test('dead jobs are a problem', () => {
  assert.equal(indicator(healthReport({ jobs: { queued: 3, leased: 1, dead: 2 } }), 'jobs'), 'jobs bad 失敗終止的工作 2');
});

test('when the report could not read past the database, every indicator says unknown', () => {
  const report = healthReport({
    status: 'critical',
    findings: [{ severity: 'critical', code: 'DATABASE_UNREACHABLE', subject: null, detail: 'connection refused' }],
    database: { reachable: false, migrations_applied: 0, migrations_pending: 0, problem: 'connection refused' },
  });
  assert.deepEqual(read(report), [
    'worker neutral worker 未知',
    'sources neutral 來源 未知',
    'quota neutral 額度 未知',
    'jobs neutral 失敗終止的工作 未知',
  ]);
});

test('the tab title leads with the state', () => {
  assert.equal(pageTitle('loading'), 'Morrow');
  assert.equal(pageTitle('unreachable'), '無法更新 · Morrow');
  assert.deepEqual(
    HEALTH_LEVELS.map((level) => pageTitle(level)),
    ['正常 · Morrow', '需注意 · Morrow', '異常 · Morrow', '嚴重 · Morrow'],
  );
  assert.deepEqual(Object.keys(LEVELS), [...HEALTH_LEVELS], 'every level has a label');
});

test('every state has a favicon file in public/', () => {
  const states: PageState[] = ['loading', 'unreachable', ...HEALTH_LEVELS];
  const publicDir = new URL('../public/', import.meta.url);
  for (const state of states) {
    const file = fileURLToPath(new URL(`.${faviconPath(state)}`, publicDir));
    assert.ok(existsSync(file), `${state}: ${file}`);
  }
  assert.equal(faviconPath('unreachable'), '/favicon-unknown.svg');
});
