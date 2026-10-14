import type pg from 'pg';
import { writeAudit } from '../db/audit.js';
import { ingestRawObservation, PARSE_CONSUMER } from './ingest.js';
import { allParsers } from './registry.js';
import type { RawParser } from './types.js';

/*
 * Reparsing (FT-04): runs the current version of each parser over the stored
 * responses it has not processed yet, typically after a parser version bump.
 *
 * Nothing is rewritten. Events and quarantined fields carry the parser
 * version in their keys, so the new version's output is stored next to the
 * old one, which stays exactly as it was. Each response is parsed in its own
 * transaction together with its "processed" mark, so an interrupted run
 * loses nothing and the next run carries on where it stopped; running it
 * twice, or while the worker parses new responses, parses nothing twice.
 */

/** What one parser has left to do. */
export interface ReparsePlanEntry {
  readonly provider: string;
  readonly capability: string;
  readonly parserVersion: string;
  /** Successful responses stored for this capability: the ones a parser reads. */
  readonly responses: number;
  /** Of those, the ones this parser version has already processed. */
  readonly parsed: number;
  /** The ones it has not: what a reparse would parse now. */
  readonly pending: number;
}

/**
 * The responses a parser reads, and whether its current version has
 * processed each. An error response is evidence of the error and is never
 * parsed, so it does not count.
 */
const COUNT_SQL = `
  SELECT count(*)::int AS responses,
         count(*) FILTER (WHERE EXISTS (
           SELECT 1 FROM consumer_inbox i WHERE i.consumer = $3 AND i.message_key = $4 || o.id::text
         ))::int AS parsed
    FROM raw_observations o
   WHERE o.provider = $1 AND o.capability = $2 AND o.outcome = 'OK' AND o.payload_sha256 IS NOT NULL`;

/** The next pending responses after `after`, oldest first. */
const PENDING_SQL = `
  SELECT o.id::text AS id
    FROM raw_observations o
   WHERE o.provider = $1 AND o.capability = $2 AND o.outcome = 'OK' AND o.payload_sha256 IS NOT NULL
     AND o.id > $5::bigint
     AND NOT EXISTS (SELECT 1 FROM consumer_inbox i WHERE i.consumer = $3 AND i.message_key = $4 || o.id::text)
   ORDER BY o.id
   LIMIT $6`;

const markPrefix = (parser: RawParser): string => `${parser.version}:`;

/** What a reparse would do now, per parser. Reads only. */
export async function planReparse(pool: pg.Pool, parsers: readonly RawParser[] = allParsers()): Promise<ReparsePlanEntry[]> {
  const plan: ReparsePlanEntry[] = [];
  for (const parser of parsers) {
    const result = await pool.query<{ responses: number; parsed: number }>(COUNT_SQL, [
      parser.provider,
      parser.capability,
      PARSE_CONSUMER,
      markPrefix(parser),
    ]);
    const { responses = 0, parsed = 0 } = result.rows[0] ?? {};
    plan.push({
      provider: parser.provider,
      capability: parser.capability,
      parserVersion: parser.version,
      responses,
      parsed,
      pending: responses - parsed,
    });
  }
  return plan;
}

export interface ReparseResult {
  readonly provider: string;
  readonly capability: string;
  readonly parserVersion: string;
  /** Responses parsed by this run. */
  readonly parsed: number;
  /** Responses another process (the worker, or a second reparse) parsed first. */
  readonly alreadyParsed: number;
  readonly eventsInserted: number;
  /** Events this version had already stored under the same key. */
  readonly eventsExisting: number;
  /** Events that contradict the one stored under their key; kept in event_conflicts. */
  readonly eventsConflicting: number;
  readonly quarantined: number;
}

export interface ReparseOptions {
  /** Pending responses read per query. */
  readonly batchSize?: number;
  /** Called after each response, with the running totals of the parser being worked on. */
  readonly onProgress?: (progress: ReparseResult) => void;
}

/**
 * Parses every stored response the current parser versions have not
 * processed, oldest first, and records the run in the audit log. Stops at
 * the first error: what was parsed until then is committed, and running it
 * again continues from there.
 */
export async function reparse(pool: pg.Pool, options: ReparseOptions = {}): Promise<ReparseResult[]> {
  // Always the registered parsers: ingestion looks its parser up there too.
  const parsers = allParsers();
  const batchSize = options.batchSize ?? 200;
  const results: ReparseResult[] = [];
  for (const parser of parsers) {
    let totals: ReparseResult = {
      provider: parser.provider,
      capability: parser.capability,
      parserVersion: parser.version,
      parsed: 0,
      alreadyParsed: 0,
      eventsInserted: 0,
      eventsExisting: 0,
      eventsConflicting: 0,
      quarantined: 0,
    };
    // Keyset on the id, so a response another process parses meanwhile is not read twice and none is skipped.
    let after = '0';
    for (;;) {
      const batch = await pool.query<{ id: string }>(PENDING_SQL, [
        parser.provider,
        parser.capability,
        PARSE_CONSUMER,
        markPrefix(parser),
        after,
        batchSize,
      ]);
      for (const { id } of batch.rows) {
        const summary = await ingestRawObservation(pool, id);
        totals = {
          ...totals,
          parsed: totals.parsed + (summary.skipped === null ? 1 : 0),
          alreadyParsed: totals.alreadyParsed + (summary.skipped === 'ALREADY_PROCESSED' ? 1 : 0),
          eventsInserted: totals.eventsInserted + summary.eventsInserted,
          eventsExisting: totals.eventsExisting + summary.eventsExisting,
          eventsConflicting: totals.eventsConflicting + summary.eventsConflicting,
          quarantined: totals.quarantined + summary.quarantined,
        };
        options.onProgress?.(totals);
      }
      const last = batch.rows.at(-1);
      if (!last || batch.rows.length < batchSize) break;
      after = last.id;
    }
    results.push(totals);
  }
  await writeAudit(pool, {
    actor: 'operator',
    action: 'parser.reparse.completed',
    detail: {
      parsers: results.map((result) => ({
        parser_version: result.parserVersion,
        capability: `${result.provider}/${result.capability}`,
        parsed: result.parsed,
        already_parsed: result.alreadyParsed,
        events_inserted: result.eventsInserted,
        events_existing: result.eventsExisting,
        events_conflicting: result.eventsConflicting,
        quarantined: result.quarantined,
      })),
    },
  });
  return results;
}
