import { z } from 'zod';
import { CanonicalEvent, EventDomain } from './event.js';
import { RequestOutcome } from './health.js';
import { Sha256Hex, UtcTimestamp } from './primitives.js';

/*
 * Read-only views of stored evidence for the evidence browser (FT-01): the
 * canonical events, the raw observations they came from, and the fields a
 * parser quarantined. Everything here is a projection of append-only tables;
 * nothing in these responses is computed or guessed.
 */

/** Page sizes the evidence endpoints accept. */
export const EVIDENCE_PAGE_DEFAULT = 50;
export const EVIDENCE_PAGE_MAX = 200;
/**
 * Bodies longer than this are cut in the response. The stored body is
 * complete; this only bounds what one request returns.
 */
export const RAW_BODY_PREVIEW_BYTES = 262_144;

/** A positive integer id or sequence number, as a string: bigint columns do not fit a JavaScript number. */
export const SeqString = z.string().regex(/^[1-9]\d{0,18}$/);
export type SeqString = z.infer<typeof SeqString>;

/** A stored event: the canonical event and its place in insertion order. */
export const StoredEvent = CanonicalEvent.extend({ recorded_seq: SeqString });
export type StoredEvent = z.infer<typeof StoredEvent>;

/** Response of `GET /api/events`: newest first. */
export const EventPage = z.strictObject({
  events: z.array(StoredEvent),
  /** Pass as `before` for the next, older page; null on the last page. */
  next_before: SeqString.nullable(),
});
export type EventPage = z.infer<typeof EventPage>;

export const REQUEST_REASONS = ['scheduled', 'retry', 'manual', 'probe', 'backfill'] as const;

/** One request that was sent to a provider, whatever came back. */
export const RawObservationView = z.strictObject({
  id: SeqString,
  provider: z.string(),
  provider_group: z.string(),
  capability: z.string(),
  request_method: z.enum(['GET', 'POST']),
  /** Never contains a credential: they are added at send time. Known secrets are also removed when read. */
  request_url: z.string(),
  /* content_type, error_class and error_detail come from the provider and are redacted when read, like the body. */
  reason: z.enum(REQUEST_REASONS),
  outcome: RequestOutcome,
  http_status: z.number().int().nullable(),
  content_type: z.string().nullable(),
  payload_sha256: Sha256Hex.nullable(),
  /** Size of the stored body; null when no body was received. */
  byte_length: z.number().int().min(0).nullable(),
  error_class: z.string().nullable(),
  error_detail: z.string().nullable(),
  duration_ms: z.number().int().min(0).nullable(),
  observed_at: UtcTimestamp,
  available_at: UtcTimestamp,
  server_date: UtcTimestamp.nullable(),
  clock_offset_ms: z.number().int().nullable(),
  run_session_id: SeqString.nullable(),
});
export type RawObservationView = z.infer<typeof RawObservationView>;

/** Response of `GET /api/raw-observations`: newest first. */
export const RawObservationPage = z.strictObject({
  observations: z.array(RawObservationView),
  next_before: SeqString.nullable(),
});
export type RawObservationPage = z.infer<typeof RawObservationPage>;

/** The stored response body, as text for reading. */
export const RawBodyView = z.strictObject({
  sha256: Sha256Hex,
  byte_length: z.number().int().min(0),
  /**
   * The body as UTF-8, cut at RAW_BODY_PREVIEW_BYTES; null when that part is
   * not valid UTF-8. When `truncated`, the bytes after the cut were neither
   * read nor checked.
   */
  text: z.string().nullable(),
  truncated: z.boolean(),
  /**
   * Something that looks like a credential was replaced in `text`. The
   * stored body is unchanged: its bytes are the evidence.
   */
  redacted: z.boolean(),
});
export type RawBodyView = z.infer<typeof RawBodyView>;

/** A field a parser received but would not interpret without guessing. */
export const QuarantineEntryView = z.strictObject({
  id: SeqString,
  raw_observation_id: SeqString,
  parser_version: z.string(),
  record_ref: z.string(),
  field_path: z.string(),
  /** The source text, cut to 1000 characters by the parser; null when the value was not a scalar. */
  raw_value: z.string().nullable(),
  reason: z.string(),
  quarantined_at: UtcTimestamp,
});
export type QuarantineEntryView = z.infer<typeof QuarantineEntryView>;

/** Response of `GET /api/quarantine`: newest first. */
export const QuarantinePage = z.strictObject({
  entries: z.array(QuarantineEntryView),
  next_before: SeqString.nullable(),
});
export type QuarantinePage = z.infer<typeof QuarantinePage>;

/** How many events of one observation the detail lists. A DEX Screener response yields at most 30. */
export const OBSERVATION_EVENTS_MAX = 500;

/** Response of `GET /api/raw-observations/:id`: the observation, its body, and what was made of it. */
export const RawObservationDetail = z.strictObject({
  observation: RawObservationView,
  body: RawBodyView.nullable(),
  quarantine: z.array(QuarantineEntryView),
  /** Events whose provenance cites this observation, in insertion order, at most OBSERVATION_EVENTS_MAX. */
  events: z.array(
    z.strictObject({
      event_id: z.uuid(),
      recorded_seq: SeqString,
      domain: EventDomain,
      action: z.string(),
      subject: z.string(),
    }),
  ),
  events_truncated: z.boolean(),
});
export type RawObservationDetail = z.infer<typeof RawObservationDetail>;
