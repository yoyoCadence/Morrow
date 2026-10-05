import { z } from 'zod';
import { Sha256Hex, UIntString, UtcTimestamp } from './primitives.js';

/**
 * The three times every observation carries. They answer different questions
 * and must never be merged:
 *
 * - `event_time`: when the thing happened, according to the source. Null when
 *   the source gives no time. The fetch time is never substituted for it.
 * - `observed_at`: when we received the data from the provider.
 * - `available_at`: when the record was durably stored and so became usable
 *   by a decision. A backfilled record keeps its real `available_at`, which
 *   is what stops a replay from using knowledge it did not have yet.
 */
export const TimeSemantics = z.strictObject({
  event_time: UtcTimestamp.nullable(),
  observed_at: UtcTimestamp,
  available_at: UtcTimestamp,
});
export type TimeSemantics = z.infer<typeof TimeSemantics>;

export const Commitment = z.enum(['processed', 'confirmed', 'finalized']);
export type Commitment = z.infer<typeof Commitment>;

/** How much of the underlying population an observation actually covers. */
export const Coverage = z.strictObject({
  completeness: z.enum(['COMPLETE', 'PARTIAL', 'UNKNOWN']),
  /** For example "top 100 holders only". Required unless coverage is complete. */
  note: z.string().max(500).optional(),
});
export type Coverage = z.infer<typeof Coverage>;

/** Where a canonical record came from, so every judgement can be traced to raw evidence. */
export const Provenance = z.strictObject({
  provider: z.string().min(1).max(64),
  /**
   * Providers that read the same upstream share a group. Two providers in one
   * group are not independent confirmation of each other.
   */
  provider_group: z.string().min(1).max(64),
  parser_version: z.string().min(1).max(64),
  raw_sha256: Sha256Hex,
  /** References to stored evidence, for example `raw_observation:1234`. */
  evidence_refs: z.array(z.string().min(1).max(256)).min(1),
  /** Solana slot for on-chain data; null for off-chain sources. */
  slot: UIntString.nullable(),
  commitment: Commitment.nullable(),
  coverage: Coverage,
});
export type Provenance = z.infer<typeof Provenance>;
