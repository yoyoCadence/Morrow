import type { NewEvent } from '@morrow/core';
import type { z } from 'zod';

/** A stored provider response that a parser reads. */
export interface StoredObservation {
  readonly id: string;
  readonly provider: string;
  readonly providerGroup: string;
  readonly capability: string;
  readonly observedAt: Date;
  readonly payloadSha256: string;
  readonly body: Buffer;
}

/** A value the parser received but would not interpret without guessing. */
export interface QuarantinedField {
  /** What the field belongs to, for example a pool address, or '$' for the whole body. */
  readonly recordRef: string;
  /** JSON path into the raw body, for example '$[0].priceChange.h1'. */
  readonly fieldPath: string;
  /** The source text, or null when the value was not a scalar. */
  readonly rawValue: string | null;
  readonly reason: string;
}

export interface ParseResult {
  readonly events: readonly z.input<typeof NewEvent>[];
  readonly quarantined: readonly QuarantinedField[];
}

/**
 * Turns one provider response into canonical events. Must be a pure function
 * of the observation, so parsing it again gives the same result.
 */
export interface RawParser {
  readonly provider: string;
  readonly capability: string;
  /** Changes whenever the mapping changes. It is part of every key the parser writes. */
  readonly version: string;
  parse(observation: StoredObservation): ParseResult;
}
