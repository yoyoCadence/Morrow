import { createHmac } from 'node:crypto';

export interface OkxSignatureInput {
  /** ISO-8601 UTC timestamp, the same string sent in OK-ACCESS-TIMESTAMP. */
  readonly timestamp: string;
  readonly method: 'GET' | 'POST';
  /** Path including the query string, exactly as sent. */
  readonly requestPath: string;
  /** Request body for POST; empty for GET. */
  readonly body: string;
  readonly secretKey: string;
}

/**
 * OKX REST signature: Base64(HMAC-SHA256(timestamp + method + requestPath + body)).
 *
 * This key is a read-only API credential. It is unrelated to any wallet
 * private key, and this build holds no wallet key at all.
 */
export function signOkxRequest(input: OkxSignatureInput): string {
  const prehash = `${input.timestamp}${input.method}${input.requestPath}${input.body}`;
  return createHmac('sha256', input.secretKey).update(prehash, 'utf8').digest('base64');
}
