import type { RequestOutcome } from '@morrow/core';
import type pg from 'pg';
import { writeAudit } from '../db/audit.js';
import type { ProviderClient } from './client.js';
import { CAPABILITIES } from './registry.js';
import type { CapabilityDefinition } from './types.js';

export const PROBE_JOB_KIND = 'provider.probe';

export interface ProbeRecord {
  readonly provider: string;
  readonly capability: string;
  readonly outcome: RequestOutcome;
  readonly httpStatus: number | null;
  readonly docVerified: boolean;
  readonly detail: string | null;
}

export interface RunProbesOptions {
  readonly pool: pg.Pool;
  readonly client: ProviderClient;
  readonly capabilities?: readonly CapabilityDefinition[];
  readonly jobId?: string | null;
  readonly runSessionId?: string | null;
}

/**
 * Measures what the configured credentials can actually use: one minimal
 * request per capability, each result stored. The point is to learn the real
 * entitlement of a free plan from the provider's answer instead of assuming it
 * from a pricing page.
 *
 * A capability without a confirmed endpoint is recorded as ENDPOINT_UNVERIFIED
 * and not called.
 */
export async function runProbes(options: RunProbesOptions): Promise<ProbeRecord[]> {
  const records: ProbeRecord[] = [];
  for (const capability of options.capabilities ?? CAPABILITIES) {
    let record: ProbeRecord;
    let rawObservationId: string | null = null;

    if (capability.probe === null) {
      record = {
        provider: capability.provider,
        capability: capability.capability,
        outcome: 'ENDPOINT_UNVERIFIED',
        httpStatus: null,
        docVerified: capability.docVerified,
        detail: capability.note,
      };
    } else {
      const result = await options.client.request({ capability, spec: capability.probe, reason: 'probe' });
      rawObservationId = result.rawObservationId;
      const received = result.body !== null ? `received ${result.body.byteLength} bytes` : null;
      record = {
        provider: capability.provider,
        capability: capability.capability,
        outcome: result.outcome,
        httpStatus: result.httpStatus,
        docVerified: capability.docVerified,
        detail: [result.detail, received, capability.docVerified ? null : capability.note].filter(Boolean).join(' | ') || null,
      };
    }

    await options.pool.query(
      `INSERT INTO provider_probes (
         provider, capability, outcome, http_status, doc_verified, detail, raw_observation_id, job_id, run_session_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        record.provider,
        record.capability,
        record.outcome,
        record.httpStatus,
        record.docVerified,
        record.detail,
        rawObservationId,
        options.jobId ?? null,
        options.runSessionId ?? null,
      ],
    );
    records.push(record);
  }

  const tally: Record<string, number> = {};
  for (const record of records) tally[record.outcome] = (tally[record.outcome] ?? 0) + 1;
  await writeAudit(options.pool, {
    actor: 'worker',
    action: 'provider.probe.completed',
    detail: { outcomes: tally, job_id: options.jobId ?? null },
    runSessionId: options.runSessionId ?? null,
  });
  return records;
}

/** The probe results written by one job, in the order they ran. */
export async function readProbeRecords(pool: pg.Pool, jobId: string): Promise<ProbeRecord[]> {
  const result = await pool.query<{
    provider: string;
    capability: string;
    outcome: RequestOutcome;
    http_status: number | null;
    doc_verified: boolean;
    detail: string | null;
  }>(
    `SELECT provider, capability, outcome, http_status, doc_verified, detail
       FROM provider_probes WHERE job_id = $1 ORDER BY id`,
    [jobId],
  );
  return result.rows.map((row) => ({
    provider: row.provider,
    capability: row.capability,
    outcome: row.outcome,
    httpStatus: row.http_status,
    docVerified: row.doc_verified,
    detail: row.detail,
  }));
}
