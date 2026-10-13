import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import path from 'node:path';
import { test } from 'node:test';
import { chromium } from 'playwright';
import type pg from 'pg';
import { createTestDb, defer, silentLogger } from '../test-support/db.js';
import { API_HOST, buildApiServer, DEFAULT_WEB_ROOT } from './server.js';

/*
 * Smoke test of the built dashboard in a real browser, served by the real
 * API from a seeded test database: light and dark, at 1280 px and at 390 px.
 * It checks what the unit tests cannot: the page loads under the API's CSP,
 * renders every section from real answers without an error, follows the
 * colour scheme, and never scrolls sideways.
 *
 * Needs the dashboard build (`npm run build`) and Chromium
 * (`npx playwright install --only-shell chromium`), or MORROW_E2E_CHROMIUM
 * naming an installed Chromium or Chrome executable.
 */

const VIEWS = [
  { name: 'light, 1280 px', width: 1280, colorScheme: 'light' },
  { name: 'dark, 1280 px', width: 1280, colorScheme: 'dark' },
  { name: 'light, 390 px', width: 390, colorScheme: 'light' },
  { name: 'dark, 390 px', width: 390, colorScheme: 'dark' },
] as const;

/** Sections every page shows, data or not. */
const SECTIONS = ['觀測覆蓋', '程序', '資料來源', '額度'];

/** A port free right now. The API must know its port before it listens, for its Host check. */
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, API_HOST, resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

/**
 * A worker running for 3 hours after one that crashed, a source down, a
 * provider-wide rate limit, a missing credential, and two quota buckets,
 * one past its warning line. Health is degraded, because a source is down.
 */
async function seed(pool: pg.Pool): Promise<void> {
  await pool.query(`
    WITH crashed AS (
      INSERT INTO run_sessions (component, mode, status, started_at, last_heartbeat_at, ended_at, host, pid, app_version)
      VALUES ('worker', 'RESEARCH', 'ABANDONED', now() - interval '20 hours', now() - interval '5 hours',
              now() - interval '3 hours', 'smoke', 1, 'test')
      RETURNING id
    ), running AS (
      INSERT INTO run_sessions (component, mode, started_at, host, pid, app_version)
      VALUES ('worker', 'RESEARCH', now() - interval '3 hours', 'smoke', 2, 'test')
      RETURNING id
    )
    INSERT INTO session_gaps (component, kind, gap_start, gap_end, previous_session_id, detected_by_session_id)
    SELECT 'worker', 'UNCLEAN_SHUTDOWN', now() - interval '5 hours', now() - interval '3 hours', crashed.id, running.id
      FROM crashed, running`);
  await pool.query(`
    INSERT INTO source_health (provider, capability, state, last_outcome, last_http_status, consecutive_failures,
                               blocked_until, last_success_at, last_failure_at)
    VALUES ('dexscreener', 'market.tokens', 'HEALTHY', 'OK', 200, 0, NULL, now() - interval '25 seconds', NULL),
           ('okx', 'token.holders', 'DOWN', 'SERVER_ERROR', 503, 4, NULL, now() - interval '2 hours', now() - interval '1 minute'),
           ('okx', '*', 'RATE_LIMITED', 'RATE_LIMITED', 429, 1, now() + interval '41 seconds', NULL, now() - interval '5 seconds'),
           ('helius', 'rpc.health', 'CREDENTIAL_MISSING', 'CREDENTIAL_MISSING', NULL, 0, NULL, NULL, NULL)`);
  await pool.query(`
    INSERT INTO quota_counters (provider, bucket, period_start, used)
    VALUES ('okx', 'basic', date_trunc('month', now() AT TIME ZONE 'UTC')::date, 24650),
           ('okx', 'premium', date_trunc('month', now() AT TIME ZONE 'UTC')::date, 72000)`);
}

/** Relative luminance of a CSS `rgb(…)` colour, from 0 (black) to 1 (white). */
function luminance(color: string): number {
  const channels = color.match(/\d+(\.\d+)?/g)?.slice(0, 3).map(Number) ?? [];
  assert.equal(channels.length, 3, `not an rgb() colour: ${color}`);
  const [r = 0, g = 0, b = 0] = channels.map((value) => {
    const c = value / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

test('the dashboard renders from the real API, light and dark, wide and narrow', async (t) => {
  assert.ok(existsSync(path.join(DEFAULT_WEB_ROOT, 'index.html')), 'build the dashboard first: npm run build');

  const db = await createTestDb();
  defer(t, () => db.close());
  await seed(db.pool);

  const port = await freePort();
  const app = await buildApiServer({ pool: db.pool, logger: silentLogger, mode: 'RESEARCH', version: 'smoke', port });
  defer(t, () => app.close());
  await app.listen({ host: API_HOST, port });
  const origin = `http://${API_HOST}:${port}`;

  const executablePath = process.env.MORROW_E2E_CHROMIUM;
  const browser = await chromium.launch(executablePath ? { executablePath } : {});
  defer(t, () => browser.close());

  for (const view of VIEWS) {
    await t.test(view.name, async () => {
      const context = await browser.newContext({ viewport: { width: view.width, height: 900 }, colorScheme: view.colorScheme });
      const page = await context.newPage();
      try {
        // Anything the browser complains about, a CSP violation included, is a failure.
        const problems: string[] = [];
        page.on('console', (message) => {
          if (message.type() === 'error' || message.type() === 'warning') problems.push(`console ${message.type()}: ${message.text()}`);
        });
        page.on('pageerror', (error) => problems.push(`page error: ${error.message}`));
        page.on('requestfailed', (request) => problems.push(`request failed: ${request.url()} ${request.failure()?.errorText ?? ''}`));
        page.on('response', (response) => {
          if (response.status() >= 400) problems.push(`HTTP ${response.status()}: ${response.url()}`);
        });

        await page.goto(origin);
        // Both coverage strips drawn: the health and both coverage answers arrived and matched the contract.
        await page.locator('.coverage-band').nth(1).waitFor();

        assert.match(await page.locator('.status-level').innerText(), /異常/);
        assert.equal(await page.title(), '異常 · Morrow');
        const icon = await page.locator('link[rel="icon"]').getAttribute('href');
        assert.equal(icon, '/favicon-degraded.svg');
        const iconResponse = await page.request.get(`${origin}${icon}`);
        assert.equal(iconResponse.status(), 200);
        assert.equal(iconResponse.headers()['content-type'], 'image/svg+xml');

        const headings = await page.locator('h2').allInnerTexts();
        for (const section of SECTIONS) assert.ok(headings.some((heading) => heading.startsWith(section)), `${section} in ${headings.join(', ')}`);
        assert.match(await page.locator('.status-bar').innerText(), /額度 最高 84%（okx\/premium）/);
        const down = await page.locator('tr').filter({ hasText: 'token.holders' }).innerText();
        assert.match(down, /DOWN/);
        assert.match(down, /premium · 84%/, 'the bucket and its share, from the registry and the quota counters');

        const sideways = await page.evaluate<number>('document.documentElement.scrollWidth - document.documentElement.clientWidth');
        assert.equal(sideways, 0, 'the page scrolls sideways');
        const scrollingCards = await page.evaluate<string[]>(
          `[...document.querySelectorAll('section.card')]
             .filter((card) => card.scrollWidth > card.clientWidth)
             .map((card) => card.querySelector('h2')?.textContent ?? '?')`,
        );
        assert.deepEqual(scrollingCards, [], 'cards that scroll sideways');

        const background = luminance(await page.evaluate<string>('getComputedStyle(document.documentElement).backgroundColor'));
        if (view.colorScheme === 'dark') assert.ok(background < 0.1, `dark background, luminance ${background}`);
        else assert.ok(background > 0.8, `light background, luminance ${background}`);

        assert.deepEqual(problems, []);
      } finally {
        await context.close();
      }
    });
  }
});
