import {
  MARKET_PAIRS_MAX,
  PAIR_SNAPSHOT_EVENT,
  PairSnapshot,
  type MarketPairsPage,
  type PairSnapshotView,
  type Provenance,
  type RejectedSnapshot,
} from '@morrow/core';
import type { Queryable } from '../db/pool.js';

/*
 * Read-only query behind the market snapshot page (FT-02): the latest
 * pair.snapshot event of every pool. Nothing is computed from the values;
 * they are the stored payloads, checked against the PairSnapshot contract.
 */

/**
 * The latest snapshot of each pool, at most $1 pools.
 *
 * `pools` is a loose index scan over events_pair_snapshot_pool_idx (migration
 * 0008): each step finds the next pool address after the previous one, so
 * the cost follows the number of pools rather than every snapshot ever
 * stored. `latest` then reads the newest entry of each pool from the same
 * index. The outer ordering only sorts the few rows that are left.
 *
 * Liquidity sorts only when KNOWN and a plain decimal; the regex keeps a
 * malformed payload from turning the cast into an error for the whole page.
 */
export const LATEST_PAIR_SNAPSHOTS_SQL = `
  WITH RECURSIVE pools(pool, ordinal) AS (
      (SELECT payload ->> 'pool_address', 1
         FROM events
        WHERE domain = 'market' AND action = 'pair.snapshot' AND payload ->> 'pool_address' IS NOT NULL
        ORDER BY payload ->> 'pool_address'
        LIMIT 1)
    UNION ALL
      SELECT next.pool, pools.ordinal + 1
        FROM pools
       CROSS JOIN LATERAL (
             SELECT payload ->> 'pool_address' AS pool
               FROM events
              WHERE domain = 'market' AND action = 'pair.snapshot' AND payload ->> 'pool_address' > pools.pool
              ORDER BY payload ->> 'pool_address'
              LIMIT 1
             ) AS next
  )
  SELECT latest.*, listed.ordinal
    FROM (SELECT pool, ordinal FROM pools LIMIT $1) AS listed
   CROSS JOIN LATERAL (
         SELECT event_id, recorded_seq::text AS seq, subject, observed_at, available_at, provenance,
                payload_version, payload, listed.pool AS pool_address
           FROM events
          WHERE domain = 'market' AND action = 'pair.snapshot' AND payload ->> 'pool_address' = listed.pool
          ORDER BY events.observed_at DESC, events.recorded_seq DESC
          LIMIT 1
         ) AS latest
   ORDER BY latest.subject,
            CASE
              WHEN latest.payload -> 'liquidity_usd' ->> 'state' = 'KNOWN'
               AND latest.payload -> 'liquidity_usd' ->> 'value' ~ '^-?(0|[1-9][0-9]*)([.][0-9]+)?$'
              THEN (latest.payload -> 'liquidity_usd' ->> 'value')::numeric
            END DESC NULLS LAST,
            latest.pool_address`;

interface SnapshotRow {
  event_id: string;
  /** recorded_seq as text. Named apart from the column so that ordering by recorded_seq stays numeric. */
  seq: string;
  subject: string;
  observed_at: Date;
  available_at: Date;
  provenance: Provenance;
  payload_version: number;
  payload: unknown;
  pool_address: string;
  /** Position of the pool in address order, counting from 1. */
  ordinal: number;
}

/**
 * The latest snapshot of every pool, up to `max` pools. A pool whose latest
 * snapshot this build cannot read is listed in `rejected`, not skipped, and
 * not replaced by an older snapshot it can read: showing an older state as
 * the current one would be wrong.
 */
export async function listLatestPairs(db: Queryable, max: number = MARKET_PAIRS_MAX): Promise<MarketPairsPage> {
  const result = await db.query<SnapshotRow>(LATEST_PAIR_SNAPSHOTS_SQL, [max + 1]);
  // One pool more than `max` was read to tell whether there are more. Pools
  // are counted in address order but returned in display order, so the extra
  // one is found by its ordinal, wherever it sorts.
  const rows = result.rows.filter((row) => row.ordinal <= max);
  const pairs: PairSnapshotView[] = [];
  const rejected: RejectedSnapshot[] = [];
  for (const row of rows) {
    const reject = (problem: RejectedSnapshot['problem']): void => {
      rejected.push({ event_id: row.event_id, recorded_seq: row.seq, pool_address: row.pool_address, problem });
    };
    if (row.payload_version !== PAIR_SNAPSHOT_EVENT.payloadVersion) {
      reject('PAYLOAD_VERSION');
      continue;
    }
    const snapshot = PairSnapshot.safeParse(row.payload);
    if (!snapshot.success) {
      reject('PAYLOAD_REJECTED');
      continue;
    }
    pairs.push({
      event_id: row.event_id,
      recorded_seq: row.seq,
      observed_at: row.observed_at.toISOString(),
      available_at: row.available_at.toISOString(),
      provider: row.provenance.provider,
      parser_version: row.provenance.parser_version,
      evidence_refs: row.provenance.evidence_refs,
      snapshot: snapshot.data,
    });
  }
  return { pairs, rejected, truncated: result.rows.some((row) => row.ordinal > max) };
}
