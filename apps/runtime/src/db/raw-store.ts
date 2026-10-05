import { createHash } from 'node:crypto';
import type { RequestOutcome } from '@morrow/core';
import type { Queryable } from './pool.js';

export type RequestReason = 'scheduled' | 'retry' | 'manual' | 'probe' | 'backfill';

export interface RawObservationInput {
  readonly provider: string;
  readonly providerGroup: string;
  readonly capability: string;
  readonly requestMethod: 'GET' | 'POST';
  /** The request URL without credentials. */
  readonly requestUrl: string;
  readonly requestFingerprint: string;
  readonly reason: RequestReason;
  readonly outcome: RequestOutcome;
  readonly httpStatus: number | null;
  readonly contentType: string | null;
  /** Exact response bytes, or null when no body was received. */
  readonly body: Buffer | null;
  readonly errorClass: string | null;
  readonly errorDetail: string | null;
  readonly durationMs: number | null;
  readonly observedAt: Date;
  readonly runSessionId: string | null;
}

export interface StoredRawObservation {
  readonly id: string;
  readonly payloadSha256: string | null;
  readonly availableAt: Date;
}

export function sha256Hex(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * Stores one provider response as evidence. Bodies are content-addressed, so
 * an identical response is stored once however often it is observed.
 */
export async function storeRawObservation(db: Queryable, input: RawObservationInput): Promise<StoredRawObservation> {
  let payloadSha256: string | null = null;
  if (input.body !== null) {
    payloadSha256 = sha256Hex(input.body);
    await db.query(
      'INSERT INTO raw_payloads (sha256, body, byte_length) VALUES ($1, $2, $3) ON CONFLICT (sha256) DO NOTHING',
      [payloadSha256, input.body, input.body.byteLength],
    );
  }
  const result = await db.query<{ id: string; available_at: Date }>(
    `INSERT INTO raw_observations (
       provider, provider_group, capability, request_method, request_url, request_fingerprint,
       reason, outcome, http_status, content_type, payload_sha256, error_class, error_detail,
       duration_ms, observed_at, run_session_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
     RETURNING id, available_at`,
    [
      input.provider,
      input.providerGroup,
      input.capability,
      input.requestMethod,
      input.requestUrl,
      input.requestFingerprint,
      input.reason,
      input.outcome,
      input.httpStatus,
      input.contentType,
      payloadSha256,
      input.errorClass,
      input.errorDetail,
      input.durationMs,
      input.observedAt,
      input.runSessionId,
    ],
  );
  const row = result.rows[0];
  if (!row) throw new Error('raw_observations insert returned no row');
  return { id: row.id, payloadSha256, availableAt: row.available_at };
}

/** Returns the stored bytes for a payload hash, or null if there are none. */
export async function readRawPayload(db: Queryable, sha256: string): Promise<Buffer | null> {
  const result = await db.query<{ body: Buffer }>('SELECT body FROM raw_payloads WHERE sha256 = $1', [sha256]);
  return result.rows[0]?.body ?? null;
}
