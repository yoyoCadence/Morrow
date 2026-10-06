import type { RequestOutcome } from '@morrow/core';
import type { EnvelopeVerdict } from './types.js';

const UNAUTHORIZED_CODES = ['50103', '50104', '50105', '50106', '50107', '50111', '50112', '50113', '50114'];

/**
 * Codes of the OKX `{code, msg, data}` envelope, from OKX's own references:
 * okx/onchainos-skills skills/okx-dex-market/references/social-troubleshooting.md
 * and cli/src/client.rs (50114). Any other non-zero code is CLIENT_ERROR, so an
 * unrecognised error can never pass as OK.
 */
const OUTCOME_BY_CODE: ReadonlyMap<string, RequestOutcome> = new Map<string, RequestOutcome>([
  ['50011', 'RATE_LIMITED'],
  ['50026', 'SERVER_ERROR'],
  ...UNAUTHORIZED_CODES.map((code): [string, RequestOutcome] => [code, 'UNAUTHORIZED']),
  // Region blocked. Like a rejected credential, only a person can fix it.
  ['50125', 'UNAUTHORIZED'],
  ['80001', 'UNAUTHORIZED'],
]);

/**
 * OKX can answer HTTP 200 with an error in its envelope. This applies the same
 * rule as OKX's own client: a body is a success only if its `code` is "0" or 0,
 * or if it is a bare array with no envelope. Anything else is an error,
 * classified by its code.
 */
export function readOkxEnvelope(body: Buffer): EnvelopeVerdict | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    return { outcome: 'CLIENT_ERROR', errorClass: 'OKX_INVALID_JSON', errorDetail: 'response body is not JSON' };
  }
  if (Array.isArray(parsed)) return null;

  const envelope = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  const code = envelope['code'];
  if (code === '0' || code === 0) return null;
  if (typeof code !== 'string' && typeof code !== 'number') {
    return { outcome: 'CLIENT_ERROR', errorClass: 'OKX_NO_ENVELOPE', errorDetail: 'response has no code field' };
  }

  const msg = envelope['msg'];
  return {
    outcome: OUTCOME_BY_CODE.get(String(code)) ?? 'CLIENT_ERROR',
    errorClass: `OKX_CODE_${String(code)}`,
    errorDetail: typeof msg === 'string' && msg.trim() !== '' ? msg.trim() : 'no message',
  };
}
