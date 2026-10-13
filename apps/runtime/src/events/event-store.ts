import { eventFactSha256, eventIdFor, NewEvent } from '@morrow/core';
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

  const stored = await db.query<{ fact_sha256: string | null }>('SELECT fact_sha256 FROM events WHERE event_id = $1', [eventId]);
  const storedFact = stored.rows[0]?.fact_sha256 ?? null;
  // Stored before facts were hashed: a contradiction cannot be told from a repeat.
  if (storedFact === null || storedFact === factSha256) return { eventId, inserted: false, conflicting: false };

  await db.query(
    `INSERT INTO event_conflicts (event_id, dedupe_key, stored_fact_sha256, incoming_fact_sha256, incoming_event)
     VALUES ($1, $2, $3, $4, $5::jsonb)
     ON CONFLICT DO NOTHING`,
    [eventId, event.dedupe_key, storedFact, factSha256, JSON.stringify(event)],
  );
  return { eventId, inserted: false, conflicting: true };
}
