import { createHash } from 'node:crypto';
import { canonicalJson } from './canonical-json.js';
import type { EventFact } from './event.js';

/*
 * Event identity: the id derived from a dedupe key and the hash of what an
 * event says happened. They need SHA-256 from node:crypto, so they live
 * here, exported from `@morrow/core/node`, and not from the main entry the
 * dashboard bundles.
 */

/**
 * Derives the event id from the dedupe key, so replaying the same inputs
 * yields the same ids. The result is a version-8 (custom) UUID per RFC 9562.
 */
export function eventIdFor(dedupeKey: string): string {
  const bytes = createHash('sha256').update(`morrow:event:${dedupeKey}`, 'utf8').digest().subarray(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x80;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = Buffer.from(bytes).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Hash of what an event says happened, as opposed to how we learned it.
 *
 * Covers the domain, action, subject, payload (with its version) and source
 * time. Leaves out the provenance and observed_at, which describe the
 * evidence, so two sources reporting the same fact hash the same; and the
 * envelope's schema_version, which describes the encoding, so a converter
 * re-emitting an old event under a newer envelope is not a contradiction.
 * Two events with one dedupe key and different fact hashes contradict each
 * other.
 *
 * The source time is compared to the millisecond, so `...18.133Z` and
 * `...18.133000Z` are the same time.
 */
export function eventFactSha256(event: EventFact): string {
  const fact = {
    domain: event.domain,
    action: event.action,
    subject: event.subject,
    payload_version: event.payload_version,
    payload: event.payload,
    event_time: event.event_time === null ? null : new Date(event.event_time).toISOString(),
  };
  return createHash('sha256').update(canonicalJson(fact), 'utf8').digest('hex');
}
