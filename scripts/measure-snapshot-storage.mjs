// Measures how many bytes one DEX Screener pair snapshot costs in each table.
//
// Usage (after `npm run build:server`, with MORROW_TEST_DATABASE_URL set):
//   node --env-file-if-exists=.env scripts/measure-snapshot-storage.mjs [observations] [pairs-per-response]
//
// Defaults: 200 observations of 30 pairs each (tokens/v1 takes up to 30
// tokens per request). Every observation goes through the real path: store
// the raw response, enqueue its parse job in the same transaction, parse it,
// mark the job done. The stored real WSOL response is the template; each pair
// gets its own addresses and each observation its own prices, so no two
// bodies are identical, as in production.
//
// Runs in a throwaway schema of the test database and drops it afterwards.
// The numbers are the basis of docs/adr/0001-storage-retention.md.
import { randomBytes } from 'node:crypto';

const dist = new URL('../apps/runtime/dist/', import.meta.url);
const load = (path) => import(new URL(path, dist).href);
const { createTestDb } = await load('test-support/db.js');
const { storeRawObservation } = await load('db/raw-store.js');
const { withTransaction } = await load('db/pool.js');
const { formatBytes, formatStorageReport, measureStorage } = await load('db/storage.js');
const { enqueueParse, ingestRawObservation } = await load('parsers/ingest.js');
const { dexscreenerTokensParser } = await load('parsers/dexscreener-tokens.js');
const { WSOL_TOKENS_RESPONSE } = await load('parsers/fixtures/dexscreener-tokens-wsol.js');

const observations = Number(process.argv[2] ?? 200);
const pairsPerResponse = Number(process.argv[3] ?? 30);

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58(bytes) {
  let n = BigInt(`0x${Buffer.from(bytes).toString('hex')}`);
  let out = '';
  while (n > 0n) {
    out = ALPHABET[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const byte of bytes) {
    if (byte !== 0) break;
    out = `1${out}`;
  }
  return out;
}

const TABLES = ['raw_payloads', 'raw_observations', 'events', 'parse_quarantine', 'jobs', 'consumer_inbox'];
const template = JSON.parse(WSOL_TOKENS_RESPONSE.body)[0];
// A fixed watchlist, polled again and again.
const watchlist = Array.from({ length: pairsPerResponse }, () => ({ pair: base58(randomBytes(32)), mint: base58(randomBytes(32)) }));

const db = await createTestDb();
async function sizes() {
  await db.pool.query('VACUUM ANALYZE');
  const result = {};
  for (const table of TABLES) {
    const row = await db.pool.query(
      `SELECT pg_total_relation_size($1::regclass)::bigint AS bytes, (SELECT count(*) FROM ${table})::bigint AS rows`,
      [`${db.schema}.${table}`],
    );
    result[table] = { bytes: Number(row.rows[0].bytes), rows: Number(row.rows[0].rows) };
  }
  return result;
}

try {
  const before = await sizes();
  const started = Date.now();
  for (let i = 0; i < observations; i += 1) {
    const body = watchlist.map((entry, k) => {
      const pair = structuredClone(template);
      if (pairsPerResponse > 1) {
        pair.pairAddress = entry.pair;
        pair.baseToken.address = entry.mint;
      }
      pair.priceUsd = (Number(template.priceUsd) + i / 1e4 + k / 1e6).toFixed(6);
      return pair;
    });
    const raw = await withTransaction(db.pool, async (tx) => {
      const stored = await storeRawObservation(tx, {
        provider: 'dexscreener',
        providerGroup: 'dexscreener',
        capability: 'market.tokens',
        requestMethod: 'GET',
        requestUrl: 'https://api.dexscreener.com/tokens/v1/solana/measurement',
        requestFingerprint: 'b'.repeat(64),
        reason: 'scheduled',
        outcome: 'OK',
        httpStatus: 200,
        contentType: 'application/json',
        body: Buffer.from(JSON.stringify(body)),
        errorClass: null,
        errorDetail: null,
        durationMs: 120,
        observedAt: new Date(Date.parse(WSOL_TOKENS_RESPONSE.observedAt) + i * 300_000),
        runSessionId: null,
        serverDate: new Date(),
        clockOffsetMs: 12,
      });
      await enqueueParse(tx, stored.id, dexscreenerTokensParser);
      return stored;
    });
    await ingestRawObservation(db.pool, raw.id);
  }
  await db.pool.query("UPDATE jobs SET status = 'succeeded', finished_at = clock_timestamp()");
  const after = await sizes();

  const snapshots = observations * pairsPerResponse;
  console.log(`${observations} responses x ${pairsPerResponse} pairs = ${snapshots} pair snapshots in ${Date.now() - started} ms\n`);
  console.log(`${'table'.padEnd(18)} ${'rows'.padStart(8)} ${'bytes/pair'.padStart(11)} ${'bytes/response'.padStart(15)}`);
  let total = 0;
  for (const table of TABLES) {
    const bytes = after[table].bytes - before[table].bytes;
    total += bytes;
    const rows = after[table].rows - before[table].rows;
    console.log(
      `${table.padEnd(18)} ${String(rows).padStart(8)} ${(bytes / snapshots).toFixed(0).padStart(11)} ${(bytes / observations).toFixed(0).padStart(15)}`,
    );
  }
  console.log(`${'all'.padEnd(18)} ${''.padStart(8)} ${(total / snapshots).toFixed(0).padStart(11)} ${(total / observations).toFixed(0).padStart(15)}`);
  console.log(`\nTotal written: ${formatBytes(total)}\n`);
  console.log(formatStorageReport(await measureStorage(db.pool)));
} finally {
  await db.close();
}
