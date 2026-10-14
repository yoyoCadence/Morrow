import { z } from 'zod';
import { isAssetIdString } from './asset-id.js';
import { DecimalString, SCHEMA_VERSION, UtcTimestamp } from './primitives.js';
import { Provenance } from './provenance.js';
import { isWithinUnitInterval } from '../numeric/decimal.js';

/**
 * Canonical events use a small fixed set of domains plus a free-form action
 * and a versioned payload. A new strategy feature becomes a registered signal,
 * not a new event domain.
 */
export const EVENT_DOMAINS = [
  'asset',
  'market',
  'liquidity',
  'flow',
  'ownership',
  'project',
  'security',
  'system',
  'decision',
] as const;
export const EventDomain = z.enum(EVENT_DOMAINS);
export type EventDomain = z.infer<typeof EventDomain>;

export const EVENT_SEVERITIES = ['INFO', 'NOTICE', 'WARNING', 'CRITICAL'] as const;
export const EventSeverity = z.enum(EVENT_SEVERITIES);
export type EventSeverity = z.infer<typeof EventSeverity>;

/** Lowercase dotted action name, for example `pool.created`. */
export const EventAction = z
  .string()
  .max(64)
  .regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/, 'expected a lowercase dotted action name');

const NON_ASSET_SUBJECT = /^(system|provider|portfolio):[a-z0-9][a-z0-9_.-]{0,62}$/;

/** What an event is about: an asset id, or a `system:` / `provider:` / `portfolio:` reference. */
export const EventSubject = z
  .string()
  .max(256)
  .refine(
    (value) => isAssetIdString(value) || NON_ASSET_SUBJECT.test(value),
    'expected an asset id or a system:/provider:/portfolio: reference',
  );

/**
 * Decimal places a confidence may have. events.confidence is numeric(7,6),
 * and PostgreSQL rounds anything finer without an error; a contract that
 * accepted more would have its values silently rewritten on storage.
 */
export const CONFIDENCE_MAX_FRACTION_DIGITS = 6;

const Confidence = DecimalString.refine(isWithinUnitInterval, 'confidence must be within [0, 1]').refine(
  (value) => (value.split('.')[1]?.length ?? 0) <= CONFIDENCE_MAX_FRACTION_DIGITS,
  `confidence has at most ${CONFIDENCE_MAX_FRACTION_DIGITS} decimal places`,
);

/** The fields a producer supplies. `event_id` and `available_at` are assigned on append. */
export const NewEvent = z.strictObject({
  schema_version: z.literal(SCHEMA_VERSION),
  /**
   * Identifies the underlying fact, so the same fact arriving twice is stored
   * once. On-chain facts must include signature, instruction path and event
   * ordinal; "same token in the same minute" is not a valid key.
   */
  dedupe_key: z.string().min(1).max(512),
  domain: EventDomain,
  action: EventAction,
  subject: EventSubject,
  payload_version: z.number().int().min(1),
  payload: z.record(z.string(), z.unknown()),
  event_time: UtcTimestamp.nullable(),
  observed_at: UtcTimestamp,
  provenance: Provenance,
  severity: EventSeverity,
  /** Null when no confidence was assessed. Not a default of 1. */
  confidence: Confidence.nullable(),
  causation_id: z.uuid().nullable(),
  correlation_id: z.uuid().nullable(),
});
export type NewEvent = z.infer<typeof NewEvent>;

export const CanonicalEvent = NewEvent.extend({
  event_id: z.uuid(),
  available_at: UtcTimestamp,
});
export type CanonicalEvent = z.infer<typeof CanonicalEvent>;

/** The fields of an event that say what happened. */
export type EventFact = Pick<
  z.input<typeof NewEvent>,
  'domain' | 'action' | 'subject' | 'payload_version' | 'payload' | 'event_time'
>;

