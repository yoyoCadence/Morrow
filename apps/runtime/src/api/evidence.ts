import {
  EVIDENCE_PAGE_DEFAULT,
  EVIDENCE_PAGE_MAX,
  EventSubject,
  OBSERVATION_EVENTS_MAX,
  RAW_BODY_PREVIEW_BYTES,
  type EventPage,
  type QuarantineEntryView,
  type QuarantinePage,
  type RawBodyView,
  type RawObservationDetail,
  type RawObservationPage,
  type RawObservationView,
  type StoredEvent,
} from '@morrow/core';
import type { Queryable } from '../db/pool.js';

/*
 * Read-only queries behind the evidence browser (FT-01). Pages are newest
 * first and keyed on a monotonic id (`before`), so a page never shifts when
 * new rows arrive. Text that came from outside (bodies, URLs, error details,
 * quarantined values) passes through `redact` on the way out: the stored
 * bytes are evidence and stay exactly as received.
 */

/** A request parameter that cannot be used; the API answers 400 with `error`. */
export class EvidenceQueryError extends Error {
  constructor(readonly error: 'INVALID_LIMIT' | 'INVALID_CURSOR' | 'INVALID_SUBJECT' | 'INVALID_FILTER' | 'INVALID_ID') {
    super(error);
    this.name = 'EvidenceQueryError';
  }
}

const SEQ = /^[1-9]\d{0,18}$/;
const BIGINT_MAX = 9_223_372_036_854_775_807n;
/** A positive id that fits PostgreSQL's bigint; anything else would be a database error, not an answer. */
const isSeq = (value: unknown): value is string => typeof value === 'string' && SEQ.test(value) && BigInt(value) <= BIGINT_MAX;
const FILTER_MAX_LENGTH = 128;

/** `limit`: absent means the default; otherwise a whole number from 1 to EVIDENCE_PAGE_MAX. */
export function parseLimit(value: unknown): number {
  if (value === undefined) return EVIDENCE_PAGE_DEFAULT;
  if (typeof value !== 'string' || !/^\d{1,4}$/.test(value)) throw new EvidenceQueryError('INVALID_LIMIT');
  const limit = Number(value);
  if (limit < 1 || limit > EVIDENCE_PAGE_MAX) throw new EvidenceQueryError('INVALID_LIMIT');
  return limit;
}

/** `before`: absent means the newest page; otherwise the `next_before` of an earlier page. */
export function parseCursor(value: unknown): string | null {
  if (value === undefined) return null;
  if (!isSeq(value)) throw new EvidenceQueryError('INVALID_CURSOR');
  return value;
}

/** An id in a path, such as `/api/raw-observations/:id`. */
export function parseId(value: unknown): string {
  if (!isSeq(value)) throw new EvidenceQueryError('INVALID_ID');
  return value;
}

/** `subject`: absent means every subject; otherwise a valid event subject. */
export function parseSubject(value: unknown): string | null {
  if (value === undefined) return null;
  if (typeof value !== 'string' || !EventSubject.safeParse(value).success) throw new EvidenceQueryError('INVALID_SUBJECT');
  return value;
}

/** A plain text filter (provider, capability, reason): absent, or a short string matched exactly. */
export function parseFilter(value: unknown): string | null {
  if (value === undefined) return null;
  if (typeof value !== 'string' || value.length === 0 || value.length > FILTER_MAX_LENGTH) throw new EvidenceQueryError('INVALID_FILTER');
  return value;
}

/** The first `limit` rows, and the cursor for the rest. The query asked for one more than `limit`. */
function page<Row extends { cursor: string }>(rows: readonly Row[], limit: number): { rows: Row[]; next: string | null } {
  const shown = rows.slice(0, limit);
  return { rows: shown, next: rows.length > limit ? (shown.at(-1)?.cursor ?? null) : null };
}

const iso = (value: Date | null): string | null => (value === null ? null : value.toISOString());

interface EventRow {
  cursor: string;
  event_id: string;
  schema_version: number;
  dedupe_key: string;
  domain: StoredEvent['domain'];
  action: string;
  subject: string;
  payload_version: number;
  payload: Record<string, unknown>;
  event_time: Date | null;
  observed_at: Date;
  available_at: Date;
  provenance: StoredEvent['provenance'];
  severity: StoredEvent['severity'];
  confidence: string | null;
  causation_id: string | null;
  correlation_id: string | null;
}

function storedEvent(row: EventRow): StoredEvent {
  return {
    recorded_seq: row.cursor,
    event_id: row.event_id,
    schema_version: row.schema_version as StoredEvent['schema_version'],
    dedupe_key: row.dedupe_key,
    domain: row.domain,
    action: row.action,
    subject: row.subject,
    payload_version: row.payload_version,
    payload: row.payload,
    event_time: iso(row.event_time),
    observed_at: row.observed_at.toISOString(),
    available_at: row.available_at.toISOString(),
    provenance: row.provenance,
    severity: row.severity,
    // numeric(7,6) comes back with trailing zeros ("0.500000"); that is the stored value, not rounded.
    confidence: row.confidence,
    causation_id: row.causation_id,
    correlation_id: row.correlation_id,
  };
}

/** Events, newest first: of one subject, or of every subject. */
export async function listEvents(
  db: Queryable,
  query: { readonly subject: string | null; readonly before: string | null; readonly limit: number },
): Promise<EventPage> {
  const result = await db.query<EventRow>(
    `SELECT recorded_seq::text AS cursor, event_id, schema_version, dedupe_key, domain, action, subject, payload_version,
            payload, event_time, observed_at, available_at, provenance, severity, confidence::text AS confidence,
            causation_id, correlation_id
       FROM events
      WHERE ($1::text IS NULL OR subject = $1) AND ($2::bigint IS NULL OR recorded_seq < $2::bigint)
      ORDER BY recorded_seq DESC
      LIMIT $3`,
    [query.subject, query.before, query.limit + 1],
  );
  const { rows, next } = page(result.rows, query.limit);
  return { events: rows.map(storedEvent), next_before: next };
}

interface ObservationRow {
  cursor: string;
  provider: string;
  provider_group: string;
  capability: string;
  request_method: RawObservationView['request_method'];
  request_url: string;
  reason: RawObservationView['reason'];
  outcome: RawObservationView['outcome'];
  http_status: number | null;
  content_type: string | null;
  payload_sha256: string | null;
  byte_length: number | null;
  error_class: string | null;
  error_detail: string | null;
  duration_ms: number | null;
  observed_at: Date;
  available_at: Date;
  server_date: Date | null;
  clock_offset_ms: string | null;
  run_session_id: string | null;
}

const OBSERVATION_COLUMNS = `o.id::text AS cursor, o.provider, o.provider_group, o.capability, o.request_method, o.request_url,
       o.reason, o.outcome, o.http_status, o.content_type, o.payload_sha256, p.byte_length, o.error_class, o.error_detail,
       o.duration_ms, o.observed_at, o.available_at, o.server_date, o.clock_offset_ms::text AS clock_offset_ms,
       o.run_session_id::text AS run_session_id`;

function observationView(row: ObservationRow, redact: (text: string) => string): RawObservationView {
  return {
    id: row.cursor,
    provider: row.provider,
    provider_group: row.provider_group,
    capability: row.capability,
    request_method: row.request_method,
    request_url: redact(row.request_url),
    reason: row.reason,
    outcome: row.outcome,
    http_status: row.http_status,
    content_type: row.content_type,
    payload_sha256: row.payload_sha256,
    byte_length: row.byte_length,
    error_class: row.error_class,
    error_detail: row.error_detail === null ? null : redact(row.error_detail),
    duration_ms: row.duration_ms,
    observed_at: row.observed_at.toISOString(),
    available_at: row.available_at.toISOString(),
    server_date: iso(row.server_date),
    clock_offset_ms: row.clock_offset_ms === null ? null : Number(row.clock_offset_ms),
    run_session_id: row.run_session_id,
  };
}

/** Raw observations, newest first, optionally of one provider and capability. */
export async function listRawObservations(
  db: Queryable,
  query: {
    readonly provider: string | null;
    readonly capability: string | null;
    readonly before: string | null;
    readonly limit: number;
  },
  redact: (text: string) => string,
): Promise<RawObservationPage> {
  const result = await db.query<ObservationRow>(
    `SELECT ${OBSERVATION_COLUMNS}
       FROM raw_observations o LEFT JOIN raw_payloads p ON p.sha256 = o.payload_sha256
      WHERE ($1::text IS NULL OR o.provider = $1) AND ($2::text IS NULL OR o.capability = $2)
        AND ($3::bigint IS NULL OR o.id < $3::bigint)
      ORDER BY o.id DESC
      LIMIT $4`,
    [query.provider, query.capability, query.before, query.limit + 1],
  );
  const { rows, next } = page(result.rows, query.limit);
  return { observations: rows.map((row) => observationView(row, redact)), next_before: next };
}

/**
 * The body as text: UTF-8, cut at `RAW_BODY_PREVIEW_BYTES`, with anything
 * credential-shaped replaced. A cut that lands inside a multi-byte character
 * drops that character rather than inventing a replacement for it.
 */
export function bodyView(
  sha256: string,
  byteLength: number,
  head: Buffer,
  redact: (text: string) => string,
): RawBodyView {
  const truncated = byteLength > head.length;
  let decoded: string | null;
  try {
    decoded = new TextDecoder('utf-8', { fatal: true }).decode(head, { stream: truncated });
  } catch {
    decoded = null;
  }
  const text = decoded === null ? null : redact(decoded);
  return { sha256, byte_length: byteLength, text, truncated, redacted: text !== decoded };
}

interface QuarantineRow {
  cursor: string;
  raw_observation_id: string;
  parser_version: string;
  record_ref: string;
  field_path: string;
  raw_value: string | null;
  reason: string;
  quarantined_at: Date;
}

const QUARANTINE_COLUMNS = `id::text AS cursor, raw_observation_id::text AS raw_observation_id, parser_version, record_ref,
       field_path, raw_value, reason, quarantined_at`;

function quarantineView(row: QuarantineRow, redact: (text: string) => string): QuarantineEntryView {
  return {
    id: row.cursor,
    raw_observation_id: row.raw_observation_id,
    parser_version: row.parser_version,
    record_ref: row.record_ref,
    field_path: row.field_path,
    raw_value: row.raw_value === null ? null : redact(row.raw_value),
    reason: row.reason,
    quarantined_at: row.quarantined_at.toISOString(),
  };
}

/** One observation, the start of its body, the fields quarantined from it, and the events that cite it. Null when there is none. */
export async function getRawObservation(
  db: Queryable,
  id: string,
  redact: (text: string) => string,
): Promise<RawObservationDetail | null> {
  const found = await db.query<ObservationRow>(
    `SELECT ${OBSERVATION_COLUMNS}
       FROM raw_observations o LEFT JOIN raw_payloads p ON p.sha256 = o.payload_sha256
      WHERE o.id = $1::bigint`,
    [id],
  );
  const row = found.rows[0];
  if (!row) return null;

  let body: RawBodyView | null = null;
  if (row.payload_sha256 !== null && row.byte_length !== null) {
    // Only the part that is shown leaves the database.
    const head = await db.query<{ head: Buffer }>('SELECT substring(body FROM 1 FOR $2) AS head FROM raw_payloads WHERE sha256 = $1', [
      row.payload_sha256,
      RAW_BODY_PREVIEW_BYTES,
    ]);
    const bytes = head.rows[0]?.head;
    if (bytes) body = bodyView(row.payload_sha256, row.byte_length, bytes, redact);
  }

  const quarantine = await db.query<QuarantineRow>(
    `SELECT ${QUARANTINE_COLUMNS} FROM parse_quarantine WHERE raw_observation_id = $1::bigint ORDER BY id`,
    [id],
  );
  const events = await db.query<{ event_id: string; recorded_seq: string; domain: StoredEvent['domain']; action: string; subject: string }>(
    `SELECT event_id, recorded_seq::text AS recorded_seq, domain, action, subject
       FROM events
      WHERE provenance -> 'evidence_refs' @> $1::jsonb
      ORDER BY recorded_seq
      LIMIT $2`,
    [JSON.stringify([`raw_observation:${id}`]), OBSERVATION_EVENTS_MAX + 1],
  );

  return {
    observation: observationView(row, redact),
    body,
    quarantine: quarantine.rows.map((entry) => quarantineView(entry, redact)),
    events: events.rows.slice(0, OBSERVATION_EVENTS_MAX),
    events_truncated: events.rows.length > OBSERVATION_EVENTS_MAX,
  };
}

/** Quarantined fields, newest first, optionally with one reason. */
export async function listQuarantine(
  db: Queryable,
  query: { readonly reason: string | null; readonly before: string | null; readonly limit: number },
  redact: (text: string) => string,
): Promise<QuarantinePage> {
  const result = await db.query<QuarantineRow>(
    `SELECT ${QUARANTINE_COLUMNS}
       FROM parse_quarantine
      WHERE ($1::text IS NULL OR reason = $1) AND ($2::bigint IS NULL OR id < $2::bigint)
      ORDER BY id DESC
      LIMIT $3`,
    [query.reason, query.before, query.limit + 1],
  );
  const { rows, next } = page(result.rows, query.limit);
  return { entries: rows.map((row) => quarantineView(row, redact)), next_before: next };
}
