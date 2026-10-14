import type pg from 'pg';
import { withTransaction, type Queryable } from '../db/pool.js';
import { appendEvent } from '../events/event-store.js';
import { enqueueJob, markProcessed } from '../jobs/job-queue.js';
import { parserFor } from './registry.js';
import type { RawParser, StoredObservation } from './types.js';

export const PARSE_JOB_KIND = 'raw.parse';
/** The consumer_inbox consumer that records which observation each parser version has processed. */
export const PARSE_CONSUMER = 'raw.parse';

/** The consumer_inbox key saying that `parserVersion` has processed this observation. */
export function parsedMarkKey(parserVersion: string, rawObservationId: string): string {
  return `${parserVersion}:${rawObservationId}`;
}

/**
 * Schedules parsing of a stored observation. Call it in the transaction that
 * stored the observation, so the evidence and the work it causes commit
 * together. One job per observation and parser version, however often this runs.
 */
export async function enqueueParse(tx: Queryable, rawObservationId: string, parser: RawParser): Promise<void> {
  await enqueueJob(tx, {
    kind: PARSE_JOB_KIND,
    payload: { raw_observation_id: rawObservationId },
    dedupeKey: `${PARSE_JOB_KIND}:${parser.version}:${rawObservationId}`,
  });
}

export interface IngestSummary {
  readonly rawObservationId: string;
  /** Null when the observation was skipped before parsing. */
  readonly parserVersion: string | null;
  /** Why nothing was parsed, or null when it was. */
  readonly skipped: 'NOT_OK' | 'NO_PARSER' | 'ALREADY_PROCESSED' | null;
  readonly eventsInserted: number;
  /** Events whose dedupe key was already stored, including the conflicting ones. */
  readonly eventsExisting: number;
  /** Events that contradict the one already stored under their dedupe key; kept in event_conflicts. */
  readonly eventsConflicting: number;
  readonly quarantined: number;
}

interface ObservationRow {
  id: string;
  provider: string;
  provider_group: string;
  capability: string;
  outcome: string;
  observed_at: Date;
  payload_sha256: string | null;
  body: Buffer | null;
}

/**
 * Parses one stored observation into canonical events and quarantined fields.
 *
 * Reads only stored evidence and never contacts a provider. Events and
 * quarantine rows are written in one transaction together with the consumer
 * dedupe mark, so a redelivered job adds nothing.
 */
export async function ingestRawObservation(pool: pg.Pool, rawObservationId: string): Promise<IngestSummary> {
  const result = await pool.query<ObservationRow>(
    `SELECT o.id, o.provider, o.provider_group, o.capability, o.outcome, o.observed_at, o.payload_sha256, p.body
       FROM raw_observations o LEFT JOIN raw_payloads p ON p.sha256 = o.payload_sha256
      WHERE o.id = $1`,
    [rawObservationId],
  );
  const row = result.rows[0];
  if (!row) throw new Error(`raw observation ${rawObservationId} does not exist`);

  const nothing = { rawObservationId, eventsInserted: 0, eventsExisting: 0, eventsConflicting: 0, quarantined: 0 };
  const parser = parserFor(row.provider, row.capability);
  if (!parser) return { ...nothing, parserVersion: null, skipped: 'NO_PARSER' };
  // Only a successful answer describes the market. An error body is evidence of the error, nothing more.
  if (row.outcome !== 'OK' || row.body === null || row.payload_sha256 === null) {
    return { ...nothing, parserVersion: parser.version, skipped: 'NOT_OK' };
  }

  const observation: StoredObservation = {
    id: row.id,
    provider: row.provider,
    providerGroup: row.provider_group,
    capability: row.capability,
    observedAt: row.observed_at,
    payloadSha256: row.payload_sha256,
    body: row.body,
  };
  const parsed = parser.parse(observation);

  return withTransaction(pool, async (tx) => {
    if (!(await markProcessed(tx, PARSE_CONSUMER, parsedMarkKey(parser.version, row.id)))) {
      return { ...nothing, parserVersion: parser.version, skipped: 'ALREADY_PROCESSED' };
    }
    let eventsInserted = 0;
    let eventsConflicting = 0;
    for (const event of parsed.events) {
      const appended = await appendEvent(tx, event);
      if (appended.inserted) eventsInserted += 1;
      if (appended.conflicting) eventsConflicting += 1;
    }
    let quarantined = 0;
    for (const field of parsed.quarantined) {
      const inserted = await tx.query(
        `INSERT INTO parse_quarantine (raw_observation_id, parser_version, record_ref, field_path, raw_value, reason)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT DO NOTHING`,
        [row.id, parser.version, field.recordRef, field.fieldPath, field.rawValue, field.reason],
      );
      quarantined += inserted.rowCount ?? 0;
    }
    return {
      rawObservationId,
      parserVersion: parser.version,
      skipped: null,
      eventsInserted,
      eventsExisting: parsed.events.length - eventsInserted,
      eventsConflicting,
      quarantined,
    };
  });
}
