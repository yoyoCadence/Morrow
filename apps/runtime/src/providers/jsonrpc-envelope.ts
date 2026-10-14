import type { RequestOutcome } from '@morrow/core';
import type { EnvelopeVerdict } from './types.js';

/*
 * JSON-RPC 2.0 responses (Helius, and any Solana RPC) report errors inside an
 * HTTP 200: `{"jsonrpc":"2.0","id":1,"error":{"code":-32005,"message":"..."}}`.
 * Judged by the status alone, every such error would be stored as OK.
 *
 * Codes are classified by the ranges the JSON-RPC 2.0 specification (§5.1)
 * defines, not by what one provider means by a code: the same -32005 is
 * "node unhealthy" in Solana's getHealth documentation and "too many
 * requests" in Helius's API schema, and neither could be checked against its
 * source when this was written. Any code outside those ranges is
 * CLIENT_ERROR, so an unrecognised error can never pass as OK.
 */

/** The request itself was wrong: parse error, invalid request, unknown method, invalid params. */
const REQUEST_ERRORS = new Set([-32700, -32600, -32601, -32602]);
const INTERNAL_ERROR = -32603;
/** Reserved for implementation-defined server errors. */
const SERVER_ERROR_RANGE = { from: -32099, to: -32000 } as const;

function outcomeOf(code: number): RequestOutcome {
  if (REQUEST_ERRORS.has(code)) return 'CLIENT_ERROR';
  if (code === INTERNAL_ERROR) return 'SERVER_ERROR';
  if (code >= SERVER_ERROR_RANGE.from && code <= SERVER_ERROR_RANGE.to) return 'SERVER_ERROR';
  return 'CLIENT_ERROR';
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** The verdict for one response object, or null when it carries a result. */
function readOne(response: unknown): EnvelopeVerdict | null {
  if (!isObject(response)) {
    return { outcome: 'CLIENT_ERROR', errorClass: 'RPC_NO_ENVELOPE', errorDetail: 'response is not a JSON-RPC object' };
  }
  const error = response['error'];
  if (error !== undefined && error !== null) {
    const code = isObject(error) ? error['code'] : undefined;
    if (typeof code !== 'number' || !Number.isInteger(code)) {
      return { outcome: 'CLIENT_ERROR', errorClass: 'RPC_INVALID_ERROR', errorDetail: 'error has no integer code' };
    }
    const message = isObject(error) ? error['message'] : undefined;
    return {
      outcome: outcomeOf(code),
      errorClass: `RPC_CODE_${code}`,
      errorDetail: typeof message === 'string' && message.trim() !== '' ? message.trim() : 'no message',
    };
  }
  // A null result is a result (for example, an account that does not exist); a missing one is not.
  if (!Object.hasOwn(response, 'result')) {
    return { outcome: 'CLIENT_ERROR', errorClass: 'RPC_NO_RESULT', errorDetail: 'response has neither result nor error' };
  }
  return null;
}

/**
 * A JSON-RPC body is a success only if every response in it has a `result`
 * and none has an `error`. A batch is judged by its first failing response.
 */
export function readJsonRpcEnvelope(body: Buffer): EnvelopeVerdict | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    return { outcome: 'CLIENT_ERROR', errorClass: 'RPC_INVALID_JSON', errorDetail: 'response body is not JSON' };
  }
  if (!Array.isArray(parsed)) return readOne(parsed);
  if (parsed.length === 0) {
    return { outcome: 'CLIENT_ERROR', errorClass: 'RPC_NO_RESULT', errorDetail: 'empty batch response' };
  }
  for (const response of parsed) {
    const verdict = readOne(response);
    if (verdict !== null) return verdict;
  }
  return null;
}
