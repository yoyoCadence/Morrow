import { eventIdFor, NewEvent } from '@morrow/core';
import type { z } from 'zod';
import type { Queryable } from '../db/pool.js';

export interface AppendResult {
  readonly eventId: string;
  /** False when an event with the same dedupe key was already stored. */
  readonly inserted: boolean;
}

/**
 * Appends a canonical event. Appending the same fact again is a no-op, so a
 * redelivered job or a re-fetched page cannot duplicate it.
 *
 * `available_at` is assigned by the database at insert. A backfilled event
 * therefore records when we actually learned it, not when it happened.
 */
export async function appendEvent(db: Queryable, input: z.input<typeof NewEvent>): Promise<AppendResult> {
  const event = NewEvent.parse(input);
  const eventId = eventIdFor(event.dedupe_key);
  const result = await db.query(
    `INSERT INTO events (
       event_id, dedupe_key, schema_version, domain, action, subject, payload_version, payload,
       event_time, observed_at, provenance, severity, confidence, causation_id, correlation_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11::jsonb, $12, $13, $14, $15)
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
    ],
  );
  return { eventId, inserted: result.rowCount === 1 };
}
