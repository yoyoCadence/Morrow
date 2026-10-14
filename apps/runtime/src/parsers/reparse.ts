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
  readonly quarantined: number;
}

export interface ReparseOptions {
  /** Pending responses read per query. */
  readonly batchSize?: number;
  /** Called after each response, with the running totals of the parser being worked on. */
  readonly onProgress?: (progress: ReparseResult) => void;
}

const auditDetail = (results: readonly ReparseResult[]) =>
  results.map((result) => ({
    parser_version: result.parserVersion,
    capability: `${result.provider}/${result.capability}`,
    parsed: result.parsed,
    already_parsed: result.alreadyParsed,
    events_inserted: result.eventsInserted,
    quarantined: result.quarantined,
  }));

/** What failed, without its message: messages can carry data, and the audit log must not. */
function errorSummary(error: unknown): { name: string; code: string | null } {
  const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : null;
  return { name: error instanceof Error ? error.name : typeof error, code };
}

/**
 * Parses every stored response the current parser versions have not
 * processed, oldest first. Stops at the first error: what was parsed until
 * then is committed, and running it again continues from there.
 *
 * Every run is in the audit log, including one with nothing to do: a
 * `started` entry before any work, so even a run that is killed leaves a
 * trace, then `completed` with what it did, or `failed` with what it did
 * before the error.
 *
 * A response this version has already processed is not parsed again, so a
 * reparse cannot tell whether the parser would now say something different;
 * that a parser is a pure function of its input is for its tests to show.
 */
export async function reparse(pool: pg.Pool, options: ReparseOptions = {}): Promise<ReparseResult[]> {
  // Always the registered parsers: ingestion looks its parser up there too.
  const parsers = allParsers();
  const batchSize = options.batchSize ?? 200;
  const results: ReparseResult[] = [];
  let current: ReparseResult | null = null;
  await writeAudit(pool, {
    actor: 'operator',
    action: 'parser.reparse.started',
    detail: { parsers: parsers.map((parser) => ({ parser_version: parser.version, capability: `${parser.provider}/${parser.capability}` })) },
  });
  try {
    for (const parser of parsers) {
      current = {
        provider: parser.provider,
        capability: parser.capability,
        parserVersion: parser.version,
        parsed: 0,
        alreadyParsed: 0,
        eventsInserted: 0,
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
          current = {
            ...current,
            parsed: current.parsed + (summary.skipped === null ? 1 : 0),
            alreadyParsed: current.alreadyParsed + (summary.skipped === 'ALREADY_PROCESSED' ? 1 : 0),
            eventsInserted: current.eventsInserted + summary.eventsInserted,
            quarantined: current.quarantined + summary.quarantined,
          };
          options.onProgress?.(current);
        }
        const last = batch.rows.at(-1);
        if (!last || batch.rows.length < batchSize) break;
        after = last.id;
      }
      results.push(current);
      current = null;
    }
  } catch (error) {
    const done = current === null ? results : [...results, current];
    // Best effort: when the database is what failed, this cannot be written either, and the error that matters is the original.
    await writeAudit(pool, {
      actor: 'operator',
      action: 'parser.reparse.failed',
      detail: { parsers: auditDetail(done), error: errorSummary(error) },
    }).catch(() => undefined);
    throw error;
  }
  await writeAudit(pool, { actor: 'operator', action: 'parser.reparse.completed', detail: { parsers: auditDetail(results) } });
  return results;
}
