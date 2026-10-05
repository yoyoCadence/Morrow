import { z } from 'zod';

/**
 * How well a value is known. Missing data is never silently turned into zero
 * or a neutral default; these states must stay distinguishable everywhere.
 */
export const KNOWN_STATES = ['KNOWN', 'UNKNOWN', 'UNSUPPORTED', 'STALE', 'CONFLICTING'] as const;
export const KnownState = z.enum(KNOWN_STATES);
export type KnownState = z.infer<typeof KnownState>;

export type Observed<T> =
  /** A current value from a source we could read and interpret. */
  | { readonly state: 'KNOWN'; readonly value: T }
  /** The last value we had, now too old to rely on. */
  | { readonly state: 'STALE'; readonly value: T; readonly reason: string }
  /** Sources disagree and we will not pick one. */
  | { readonly state: 'CONFLICTING'; readonly candidates: readonly T[]; readonly reason: string }
  /** We have no value: absent, unreadable, or not interpretable without guessing. */
  | { readonly state: 'UNKNOWN'; readonly reason: string }
  /** The source or this build cannot provide this value at all. */
  | { readonly state: 'UNSUPPORTED'; readonly reason: string };

export const knownValue = <T>(value: T): Observed<T> => ({ state: 'KNOWN', value });
export const unknownValue = <T = never>(reason: string): Observed<T> => ({ state: 'UNKNOWN', reason });
export const unsupportedValue = <T = never>(reason: string): Observed<T> => ({ state: 'UNSUPPORTED', reason });
export const staleValue = <T>(value: T, reason: string): Observed<T> => ({ state: 'STALE', value, reason });
export const conflictingValues = <T>(candidates: readonly T[], reason: string): Observed<T> => ({
  state: 'CONFLICTING',
  candidates,
  reason,
});

/** Builds the schema for `Observed<T>` from the schema of `T`. */
export function observedSchema<T extends z.ZodType>(value: T) {
  const reason = z.string().min(1);
  return z.discriminatedUnion('state', [
    z.strictObject({ state: z.literal('KNOWN'), value }),
    z.strictObject({ state: z.literal('STALE'), value, reason }),
    z.strictObject({ state: z.literal('CONFLICTING'), candidates: z.array(value).min(2), reason }),
    z.strictObject({ state: z.literal('UNKNOWN'), reason }),
    z.strictObject({ state: z.literal('UNSUPPORTED'), reason }),
  ]);
}
