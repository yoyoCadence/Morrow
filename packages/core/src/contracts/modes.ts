import { z } from 'zod';

/**
 * Every operating mode the roadmap defines. Only the first three can run in
 * this build; the rest exist so that asking for one produces a clear refusal
 * rather than an unknown-value error.
 */
export const OPERATING_MODES = [
  'OFF',
  'RESEARCH',
  'PAPER',
  'SHADOW',
  'LIVE_CANARY',
  'EXIT_ONLY',
  'GUARDED_AUTO',
  'FULL_AUTO',
] as const;
export const OperatingMode = z.enum(OPERATING_MODES);
export type OperatingMode = z.infer<typeof OperatingMode>;

/**
 * Modes that are allowed to start. There is no signer, private key or funded
 * wallet in M0-M4 and every live limit is zero, so nothing beyond PAPER is
 * reachable. Widening this list is a human decision made under a later
 * milestone; nothing in the system may do it by itself.
 */
export const ENABLED_MODES = ['OFF', 'RESEARCH', 'PAPER'] as const;
export type EnabledMode = (typeof ENABLED_MODES)[number];

export class ModeNotEnabledError extends Error {
  readonly requestedMode: string;

  constructor(requestedMode: string) {
    super(
      `Mode "${requestedMode}" is not enabled. This build runs only ${ENABLED_MODES.join(', ')}: ` +
        'there is no signer and all live limits are zero.',
    );
    this.name = 'ModeNotEnabledError';
    this.requestedMode = requestedMode;
  }
}

/** Returns the mode if it may run, and throws for a live mode or an unknown value. */
export function requireEnabledMode(value: string): EnabledMode {
  const enabled = ENABLED_MODES.find((mode) => mode === value);
  if (enabled === undefined) throw new ModeNotEnabledError(value);
  return enabled;
}
