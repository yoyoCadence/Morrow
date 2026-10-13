import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { type TestContext, test } from 'node:test';
import { CoverageReport } from '@morrow/core';
import { FetchError, fetchChecked, startPolling } from './poll.js';

const coverage: CoverageReport = {
  component: 'worker',
  from: '2026-10-13T03:00:00.000Z',
  to: '2026-10-14T03:00:00.000Z',
  window_ms: 86_400_000,
  observed_ms: 86_400_000,
  segments: [{ start: '2026-10-13T03:00:00.000Z', end: '2026-10-14T03:00:00.000Z', observing: true, reason: null }],
};

/** A local server whose routes answer well, badly, or not at all. */
async function startServer(t: TestContext): Promise<string> {
  const server = http.createServer((request, response) => {
    switch (request.url) {
      case '/ok':
        response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(coverage));
        return;
      case '/drift': {
        const { observed_ms: _dropped, ...rest } = coverage;
        response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(rest));
        return;
      }
      case '/html':
        response.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><title>Morrow</title>');
        return;
      case '/error':
        response.writeHead(500, { 'content-type': 'application/json' }).end('{"error":"COVERAGE_UNAVAILABLE"}');
        return;
      case '/no-answer':
        return;
      case '/stalled-body':
        // The headers arrive, the body never finishes.
        response.writeHead(200, { 'content-type': 'application/json' });
        response.write('{"component":');
        return;
    }
    response.writeHead(404).end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    server.close();
    await once(server, 'close');
  });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function problemOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof FetchError, String(error));
    return `${error.problem}: ${error.message}`;
  }
  assert.fail('expected the request to fail');
}

test('an answer that matches the contract is returned as is', async (t) => {
  const base = await startServer(t);
  assert.deepEqual(await fetchChecked(`${base}/ok`, CoverageReport, 1_000, new AbortController().signal), coverage);
});

test('an answer that does not match the contract is an error naming the first field', async (t) => {
  const base = await startServer(t);
  const signal = new AbortController().signal;
  assert.match(await problemOf(fetchChecked(`${base}/drift`, CoverageReport, 1_000, signal)), /^contract: 回應不符合契約：observed_ms /);
  assert.equal(await problemOf(fetchChecked(`${base}/html`, CoverageReport, 1_000, signal)), 'contract: 回應不是 JSON');
  assert.equal(await problemOf(fetchChecked(`${base}/error`, CoverageReport, 1_000, signal)), 'http: HTTP 500');
});

test('no answer in time is a timeout, also when only the body is late', async (t) => {
  const base = await startServer(t);
  const signal = new AbortController().signal;
  assert.equal(await problemOf(fetchChecked(`${base}/no-answer`, CoverageReport, 200, signal)), 'timeout: 0.2 秒內沒有回應');
  assert.equal(
    await problemOf(fetchChecked(`${base}/stalled-body`, CoverageReport, 200, signal)),
    'timeout: 0.2 秒內沒有收完回應',
    'a body cut off by the deadline is not a contract problem',
  );
});

test('no connection, or the page going away, is a network problem', async (t) => {
  const base = await startServer(t);
  const closed = http.createServer();
  closed.listen(0, '127.0.0.1');
  await once(closed, 'listening');
  const port = (closed.address() as AddressInfo).port;
  closed.close();
  await once(closed, 'close');
  assert.match(await problemOf(fetchChecked(`http://127.0.0.1:${port}/ok`, CoverageReport, 1_000, new AbortController().signal)), /^network: /);

  const leaving = new AbortController();
  const pending = problemOf(fetchChecked(`${base}/stalled-body`, CoverageReport, 5_000, leaving.signal));
  setTimeout(() => leaving.abort(), 100);
  assert.match(await pending, /^network: /, 'cancelled while the body was arriving');
});

/** The parts of `window` and `document` that startPolling uses, with mocked timers. */
class FakePage extends EventTarget {
  hidden = false;
  setHidden(hidden: boolean): void {
    this.hidden = hidden;
    this.dispatchEvent(new Event('visibilitychange'));
  }
}

const PACE = { visibleMs: 10_000, hiddenMs: 60_000 };

/**
 * Installs the page and mocked timers for one test. `poll` starts polling
 * on it; whatever it started is stopped before the page is taken away.
 */
function fakePage(t: TestContext): { page: FakePage; poll: (task: () => Promise<void>) => () => void } {
  const page = new FakePage();
  const stops: Array<() => void> = [];
  Object.defineProperty(globalThis, 'window', { value: globalThis, configurable: true, writable: true });
  Object.defineProperty(globalThis, 'document', { value: page, configurable: true, writable: true });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => {
    for (const stop of stops) stop();
    Reflect.deleteProperty(globalThis, 'window');
    Reflect.deleteProperty(globalThis, 'document');
  });
  return {
    page,
    poll: (task) => {
      const stop = startPolling(task, PACE);
      stops.push(stop);
      return stop;
    },
  };
}

/** A task whose runs finish only when the test says so. */
function heldTask() {
  const running: Array<() => void> = [];
  let runs = 0;
  return {
    task: (): Promise<void> => {
      runs += 1;
      return new Promise((resolve) => running.push(resolve));
    },
    runs: () => runs,
    /** Lets the oldest run finish and waits until startPolling has seen it. */
    finish: async (): Promise<void> => {
      running.shift()?.();
      await new Promise((resolve) => setImmediate(resolve));
    },
  };
}

test('runs at once, then a pause after each run ends, so two runs never overlap', async (t) => {
  const { poll } = fakePage(t);
  const held = heldTask();
  poll(held.task);
  assert.equal(held.runs(), 1);

  t.mock.timers.tick(PACE.visibleMs * 5);
  assert.equal(held.runs(), 1, 'a slow run is not joined by another');

  await held.finish();
  t.mock.timers.tick(PACE.visibleMs - 1);
  assert.equal(held.runs(), 1);
  t.mock.timers.tick(1);
  assert.equal(held.runs(), 2, 'the pause counts from the end of the run');
});

test('slower in a background tab, and at once when the tab comes back', async (t) => {
  const { page, poll } = fakePage(t);
  page.hidden = true;
  const held = heldTask();
  poll(held.task);
  await held.finish();

  t.mock.timers.tick(PACE.visibleMs);
  assert.equal(held.runs(), 1, 'hidden: not at the visible pace');
  page.setHidden(false);
  assert.equal(held.runs(), 2, 'visible again: runs at once');

  await held.finish();
  t.mock.timers.tick(PACE.hiddenMs);
  assert.equal(held.runs(), 3, 'the hidden-pace timer was replaced, not kept as a second one');
});

test('the tab coming back during a run does not start a second one', async (t) => {
  const { page, poll } = fakePage(t);
  page.hidden = true;
  const held = heldTask();
  poll(held.task);
  page.setHidden(false);
  assert.equal(held.runs(), 1);

  await held.finish();
  t.mock.timers.tick(PACE.visibleMs);
  assert.equal(held.runs(), 2, 'the run in flight scheduled the next one at the visible pace');
});

test('after stop nothing runs again, not even a run that was in flight', async (t) => {
  const { page, poll } = fakePage(t);
  const held = heldTask();
  const stop = poll(held.task);
  stop();
  await held.finish();
  t.mock.timers.tick(PACE.hiddenMs * 10);
  page.setHidden(true);
  page.setHidden(false);
  assert.equal(held.runs(), 1);
});
