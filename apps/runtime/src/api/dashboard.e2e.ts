import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import path from 'node:path';
import { test } from 'node:test';
import { chromium, type Page } from 'playwright';
import type pg from 'pg';
import { sha256Hex, storeRawObservation } from '../db/raw-store.js';
import { WSOL_TOKENS_RESPONSE } from '../parsers/fixtures/dexscreener-tokens-wsol.js';
import { ingestRawObservation } from '../parsers/ingest.js';
import { createTestDb, defer, silentLogger } from '../test-support/db.js';
import { API_HOST, buildApiServer, DEFAULT_WEB_ROOT } from './server.js';

/*
 * Smoke test of the built dashboard in a real browser, served by the real
 * API from a seeded test database: light and dark, at 1280 px and at 390 px.
 * It checks what the unit tests cannot: the page loads under the API's CSP,
 * renders every section from real answers without an error, follows the
 * colour scheme, and never scrolls sideways. The same goes for the evidence
 * page and an observation's detail, reached through the page links.
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

/** A real DEX Screener response, stored and parsed: one event and some quarantined fields to browse. */
async function seedEvidence(pool: pg.Pool): Promise<string> {
  const stored = await storeRawObservation(pool, {
    provider: 'dexscreener',
    providerGroup: 'dexscreener',
    capability: 'market.tokens',
    requestMethod: 'GET',
    requestUrl: 'https://api.dexscreener.com/tokens/v1/solana/So11111111111111111111111111111111111111112',
    requestFingerprint: sha256Hex('smoke'),
    reason: 'scheduled',
    outcome: 'OK',
    httpStatus: 200,
    contentType: 'application/json',
    body: Buffer.from(WSOL_TOKENS_RESPONSE.body, 'utf8'),
    errorClass: null,
    errorDetail: null,
    durationMs: 113,
    // Ten minutes old: past the five minutes after which the market page marks a snapshot out of date.
    observedAt: new Date(Date.now() - 10 * 60_000),
    runSessionId: null,
  });
  await ingestRawObservation(pool, stored.id);
  return stored.id;
}

/** Fails when the page, or any card on it, scrolls sideways. */
async function assertNoSidewaysScroll(page: Page, where: string): Promise<void> {
  const sideways = await page.evaluate<number>('document.documentElement.scrollWidth - document.documentElement.clientWidth');
  assert.equal(sideways, 0, `${where}: the page scrolls sideways`);
  const scrollingCards = await page.evaluate<string[]>(
    `[...document.querySelectorAll('section.card')]
       .filter((card) => card.scrollWidth > card.clientWidth)
       .map((card) => card.querySelector('h2')?.textContent ?? '?')`,
  );
  assert.deepEqual(scrollingCards, [], `${where}: cards that scroll sideways`);
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
  const observationId = await seedEvidence(db.pool);

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

        await assertNoSidewaysScroll(page, 'system');

        const background = luminance(await page.evaluate<string>('getComputedStyle(document.documentElement).backgroundColor'));
        if (view.colorScheme === 'dark') assert.ok(background < 0.1, `dark background, luminance ${background}`);
        else assert.ok(background > 0.8, `light background, luminance ${background}`);

        // The market page: the seeded snapshot, its values exactly as observed, and the ones that are not known, with why.
        await page.getByRole('link', { name: '市場', exact: true }).click();
        await page.locator('.market-pairs tbody tr').first().waitFor();
        assert.equal(new URL(page.url()).pathname, '/market');
        const pair = await page.locator('.market-pairs tbody tr').first().innerText();
        assert.match(pair, /120\.78/);
        assert.match(pair, /30,663,136\.63/, 'liquidity, every digit');
        assert.match(pair, /39,938/);
        assert.match(pair, /未知：單位未確認/, '24h volume: sent, in a unit nobody has confirmed');
        assert.match(pair, /10 分鐘前/);
        assert.match(pair, /過時/, 'older than five minutes');
        assert.equal(await page.locator('.market-pairs .observed').first().getAttribute('title'), 'UNKNOWN · UNIT_UNVERIFIED');
        await page.locator('.market-pairs').getByRole('button', { name: '展開' }).click();
        const detail = await page.locator('.market-pairs .detail-row').innerText();
        assert.match(detail, /120\.7831/, 'the price in the quote asset');
        assert.match(detail, /未知：來源未提供/, 'FDV and market cap were not sent');
        await assertNoSidewaysScroll(page, 'market');

        // The evidence page, through the page links, then one observation and back.
        await page.getByRole('link', { name: '證據', exact: true }).click();
        await page.locator('.evidence-events tbody tr').first().waitFor();
        assert.equal(new URL(page.url()).pathname, '/evidence');
        assert.match(await page.locator('.evidence-events tbody').innerText(), /market · pair\.snapshot/);
        await page.locator('.evidence-quarantine tbody tr').first().waitFor();
        // An event's payload opens in a row of its own, as wide as the table.
        await page.getByRole('button', { name: '展開' }).first().click();
        assert.match(await page.locator('.detail-row pre.json').innerText(), /"evidence_refs"/);
        await assertNoSidewaysScroll(page, 'evidence');

        await page.locator('.evidence-observations').getByRole('link', { name: `#${observationId}` }).click();
        await page.locator('pre.body').waitFor();
        assert.equal(new URL(page.url()).pathname, `/evidence/observations/${observationId}`);
        assert.match(await page.locator('pre.body').innerText(), /"pairAddress"/, 'the stored response, as received');
        assert.match(await page.locator('.event-list').innerText(), /market · pair\.snapshot/);
        await assertNoSidewaysScroll(page, 'observation');

        await page.goBack();
        await page.locator('.evidence-events tbody tr').first().waitFor();
        assert.equal(new URL(page.url()).pathname, '/evidence', 'the back button returns to the list');

        assert.deepEqual(problems, []);
      } finally {
        await context.close();
      }
    });
  }

  await t.test('a list that fails to load can be retried without reloading the page', async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    try {
      // The first quarantine request fails as if the API were restarting; later ones go through.
      let failed = false;
      await page.route('**/api/quarantine', async (route) => {
        if (failed) return route.continue();
        failed = true;
        return route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"EVIDENCE_UNAVAILABLE"}' });
      });
      await page.goto(`${origin}/evidence`);
      const retry = page.getByRole('button', { name: '重試' });
      await retry.waitFor();
      assert.match(await page.locator('.alert').filter({ has: retry }).innerText(), /HTTP 503/);
      await retry.click();
      await page.locator('.evidence-quarantine tbody tr').first().waitFor();
      assert.equal(await retry.count(), 0, 'the alert is gone once the list loads');
    } finally {
      await context.close();
    }
  });
});
