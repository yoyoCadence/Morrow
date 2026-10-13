import { eventFactSha256, eventIdFor, NewEvent, type EventFact } from '@morrow/core';
import type { z } from 'zod';
import type { Queryable } from '../db/pool.js';

export interface AppendResult {
  readonly eventId: string;
  /** False when an event with the same dedupe key was already stored. */
  readonly inserted: boolean;
  /**
   * True when the stored event under this dedupe key says something
   * different. The incoming one is recorded in event_conflicts, not stored
   * as an event.
   */
  readonly conflicting: boolean;
}

interface StoredFactRow {
  fact_sha256: string | null;
  domain: EventFact['domain'];
  action: string;
  subject: string;
  payload_version: number;
  payload: Record<string, unknown>;
  event_time: Date | null;
}

/**
 * The fact hash of a stored event. Events stored before migration 0004 have
 * none, and append-only rows cannot be given one, so it is derived from the
 * stored columns with the same function. That is exact: key order does not
 * matter to the hash, a JSON number survives the jsonb round trip unchanged,
 * and the source time is compared to the millisecond on both sides.
 */
async function storedFactSha256(db: Queryable, eventId: string): Promise<string> {
  const result = await db.query<StoredFactRow>(
    'SELECT fact_sha256, domain, action, subject, payload_version, payload, event_time FROM events WHERE event_id = $1',
    [eventId],
  );
  const row = result.rows[0];
  if (!row) throw new Error(`event ${eventId} conflicted on insert but cannot be read`);
  return (
    row.fact_sha256 ??
    eventFactSha256({
      domain: row.domain,
      action: row.action,
      subject: row.subject,
      payload_version: row.payload_version,
      payload: row.payload,
      event_time: row.event_time?.toISOString() ?? null,
    })
  );
}

/**
 * Appends a canonical event. Appending the same fact again is a no-op, so a
 * redelivered job or a re-fetched page cannot duplicate it. A different fact
 * under a dedupe key that is already taken is a contradiction: it is kept in
 * event_conflicts instead of being dropped.
 *
 * `available_at` is assigned by the database at insert. A backfilled event
 * therefore records when we actually learned it, not when it happened.
 */
export async function appendEvent(db: Queryable, input: z.input<typeof NewEvent>): Promise<AppendResult> {
  const event = NewEvent.parse(input);
  const eventId = eventIdFor(event.dedupe_key);
  const factSha256 = eventFactSha256(event);
  const result = await db.query(
    `INSERT INTO events (
       event_id, dedupe_key, schema_version, domain, action, subject, payload_version, payload,
       event_time, observed_at, provenance, severity, confidence, causation_id, correlation_id, fact_sha256)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11::jsonb, $12, $13, $14, $15, $16)
     ON CONFLICT DO NOTHING`,
    [
      eventId,
      event.dedupe_key,
      event.schema_version,
      event.domain,
      event.action,
      event.subject,
      event.payload_version,
      JSON.stringify(event.payload),
      event.event_time,
      event.observed_at,
      JSON.stringify(event.provenance),
      event.severity,
      event.confidence,
      event.causation_id,
      event.correlation_id,
      factSha256,
    ],
  );
  if (result.rowCount === 1) return { eventId, inserted: true, conflicting: false };

  const storedFact = await storedFactSha256(db, eventId);
  if (storedFact === factSha256) return { eventId, inserted: false, conflicting: false };

  await db.query(
    `INSERT INTO event_conflicts (event_id, dedupe_key, stored_fact_sha256, incoming_fact_sha256, incoming_event)
     VALUES ($1, $2, $3, $4, $5::jsonb)
     ON CONFLICT DO NOTHING`,
    [eventId, event.dedupe_key, storedFact, factSha256, JSON.stringify(event)],
  );
  return { eventId, inserted: false, conflicting: true };
}
