import type { RequestOutcome } from '@morrow/core';
import type pg from 'pg';
import type { ProviderCredentials } from '../config/config.js';
import { withTransaction } from '../db/pool.js';
import { sha256Hex, storeRawObservation, type RequestReason } from '../db/raw-store.js';
import type { Logger } from '../logging/logger.js';
import { enqueueParse } from '../parsers/ingest.js';
import { parserFor } from '../parsers/registry.js';
import { findQuotaPolicy, reserveQuota } from '../quota/quota-ledger.js';
import { SmoothRateLimiter } from './rate-limiter.js';
import { PROVIDERS } from './registry.js';
import { nextHealth, readSourceHealth, shouldSuppress, writeSourceHealth, type OutcomeInfo } from './source-health.js';
import {
  publicUrl,
  type AuthorizedRequest,
  type CapabilityDefinition,
  type ProviderDefinition,
  type ProviderId,
  type RequestSpec,
} from './types.js';

export interface ProviderClientOptions {
  readonly pool: pg.Pool;
  readonly logger: Logger;
  readonly credentials: ProviderCredentials;
  /** Removes secrets from error text before it is stored. */
  readonly redact: (text: string) => string;
  readonly providers?: Readonly<Record<ProviderId, ProviderDefinition>>;
  readonly getRunSessionId?: () => string | null;
  readonly fetch?: typeof fetch;
  readonly now?: () => Date;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly timeoutMs?: number;
  readonly maxBodyBytes?: number;
}

export interface ProviderRequest {
  readonly capability: CapabilityDefinition;
  readonly spec: RequestSpec;
  /** Why the request is being made. Every reason is recorded and every one counts against quota. */
  readonly reason: RequestReason;
}

export interface ProviderResult {
  readonly outcome: RequestOutcome;
  readonly httpStatus: number | null;
  /** Response bytes when a response was received, whatever its status. */
  readonly body: Buffer | null;
  readonly payloadSha256: string | null;
  /** Evidence row for this request, or null when no request was sent. */
  readonly rawObservationId: string | null;
  readonly detail: string | null;
}

// Certificate verification failures. The usual cause on a managed network is
// TLS interception; the data on such a connection is not trusted.
const TLS_ERROR_CODES = new Set([
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'CERT_UNTRUSTED',
  'CERT_REVOKED',
  'CERT_SIGNATURE_FAILURE',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);
const TIMEOUT_ERROR_CODES = new Set(['UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'ETIMEDOUT']);

export function classifyStatus(status: number): RequestOutcome {
  if (status >= 200 && status < 300) return 'OK';
  if (status === 401 || status === 403) return 'UNAUTHORIZED';
  if (status === 402) return 'PAYMENT_REQUIRED';
  if (status === 404) return 'NOT_FOUND';
  if (status === 429) return 'RATE_LIMITED';
  if (status >= 500) return 'SERVER_ERROR';
  // Includes 3xx: redirects are never followed, so one is an unexpected answer.
  return 'CLIENT_ERROR';
}

export function classifyFetchError(error: unknown): { outcome: RequestOutcome; errorClass: string; message: string } {
  const top = error instanceof Error ? error : new Error(String(error));
  const cause = top.cause instanceof Error ? top.cause : undefined;
  const code = [cause, top]
    .map((candidate) => (candidate as NodeJS.ErrnoException | undefined)?.code)
    .find((candidate): candidate is string => typeof candidate === 'string');
  const message = cause ? `${top.message}: ${cause.message}` : top.message;

  if (top.name === 'TimeoutError' || cause?.name === 'TimeoutError' || (code && TIMEOUT_ERROR_CODES.has(code))) {
    return { outcome: 'TIMEOUT', errorClass: code ?? 'TimeoutError', message };
  }
  if (code && TLS_ERROR_CODES.has(code)) return { outcome: 'TLS_UNTRUSTED', errorClass: code, message };
  return { outcome: 'NETWORK_ERROR', errorClass: code ?? top.name, message };
}

/** Parses Retry-After, which is either a number of seconds or an HTTP date. */
export function parseRetryAfterMs(header: string | null, now: Date): number | null {
  if (header === null) return null;
  const trimmed = header.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const date = Date.parse(trimmed);
  return Number.isNaN(date) ? null : Math.max(0, date - now.getTime());
}

class ResponseTooLargeError extends Error {}

async function readBody(response: Response, maxBytes: number): Promise<Buffer> {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new ResponseTooLargeError(`response exceeded ${maxBytes} bytes`);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

interface Attempt {
  readonly info: OutcomeInfo;
  readonly body: Buffer | null;
  readonly contentType: string | null;
  readonly errorClass: string | null;
  readonly errorDetail: string | null;
}

/**
 * The only path by which this system talks to a data provider.
 *
 * In order, a request is: checked against source health, authorised, charged
 * to the quota ledger, paced by the rate limiter, sent, stored as raw
 * evidence, and reflected in source health. A successful response that has a
 * parser also gets a parse job in that same transaction. It is never retried here: a retry
 * is a new request with its own quota charge, scheduled by the job queue.
 */
export class ProviderClient {
  readonly #options: ProviderClientOptions;
  readonly #providers: Readonly<Record<ProviderId, ProviderDefinition>>;
  readonly #limiters = new Map<ProviderId, SmoothRateLimiter>();
  readonly #now: () => Date;

  constructor(options: ProviderClientOptions) {
    this.#options = options;
    this.#providers = options.providers ?? PROVIDERS;
    this.#now = options.now ?? (() => new Date());
  }

  async request(request: ProviderRequest): Promise<ProviderResult> {
    const { pool, logger, credentials } = this.#options;
    const { capability, spec, reason } = request;
    const provider = this.#providers[capability.provider];
    if (provider.metered && capability.quotaBucket === null) {
      throw new Error(`${provider.id}/${capability.capability} is on a metered provider but names no quota bucket`);
    }
    const log = logger.child({ provider: provider.id, capability: capability.capability, reason });
    const startedAt = this.#now();

    const health = await readSourceHealth(pool, provider.id, capability.capability);
    if (shouldSuppress(health, reason, startedAt)) {
      return notSent('SUPPRESSED', `source is ${health?.state ?? 'blocked'}`);
    }

    const authorized = provider.authorize(spec, credentials, startedAt);
    if (!authorized) {
      const next = nextHealth(health, { outcome: 'CREDENTIAL_MISSING', httpStatus: null, retryAfterMs: null }, startedAt);
      if (next) await writeSourceHealth(pool, provider.id, capability.capability, next, null);
      return notSent('CREDENTIAL_MISSING', 'credentials for this provider are not configured');
    }

    if (capability.quotaBucket !== null) {
      const policy = findQuotaPolicy(provider.id, capability.quotaBucket);
      const decision = await reserveQuota(pool, policy, {
        capability: capability.capability,
        reason,
        units: capability.units,
        at: startedAt,
      });
      if (decision.crossedWarn) {
        log.warn({ bucket: policy.bucket, used: decision.usedAfter, warnAt: policy.warnAt }, 'quota warning level reached');
      }
      if (decision.decision === 'DENY_HARD_STOP') {
        log.error({ bucket: policy.bucket, used: decision.usedAfter }, 'quota hard stop: request not sent');
        return notSent('QUOTA_HARD_STOP', `${policy.bucket} budget exhausted for this period`);
      }
    }

    await this.#limiter(provider).acquire();

    const sentAt = this.#now();
    const attempt = await this.#send(provider, authorized, spec.method);
    const observedAt = this.#now();

    const stored = await withTransaction(pool, async (tx) => {
      const raw = await storeRawObservation(tx, {
        provider: provider.id,
        providerGroup: provider.group,
        capability: capability.capability,
        requestMethod: spec.method,
        requestUrl: publicUrl(spec),
        requestFingerprint: sha256Hex(JSON.stringify([spec.method, publicUrl(spec), sha256Hex(spec.body ?? '')])),
        reason,
        outcome: attempt.info.outcome,
        httpStatus: attempt.info.httpStatus,
        contentType: attempt.contentType,
        body: attempt.body,
        errorClass: attempt.errorClass,
        errorDetail: attempt.errorDetail,
        durationMs: Math.max(0, observedAt.getTime() - sentAt.getTime()),
        observedAt,
        runSessionId: this.#options.getRunSessionId?.() ?? null,
      });
      const next = nextHealth(health, attempt.info, observedAt);
      if (next) await writeSourceHealth(tx, provider.id, capability.capability, next, raw.id);
      // Evidence and the parsing it calls for commit together, so neither exists without the other.
      const parser = attempt.info.outcome === 'OK' ? parserFor(provider.id, capability.capability) : null;
      if (parser) await enqueueParse(tx, raw.id, parser);
      return raw;
    });

    log.info({ outcome: attempt.info.outcome, httpStatus: attempt.info.httpStatus, rawObservationId: stored.id }, 'provider request');
    return {
      outcome: attempt.info.outcome,
      httpStatus: attempt.info.httpStatus,
      body: attempt.body,
      payloadSha256: stored.payloadSha256,
      rawObservationId: stored.id,
      detail: attempt.errorClass,
    };
  }

  #limiter(provider: ProviderDefinition): SmoothRateLimiter {
    let limiter = this.#limiters.get(provider.id);
    if (!limiter) {
      const sleep = this.#options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
      limiter = new SmoothRateLimiter(provider.minIntervalMs, () => this.#now().getTime(), sleep);
      this.#limiters.set(provider.id, limiter);
    }
    return limiter;
  }

  async #send(provider: ProviderDefinition, authorized: AuthorizedRequest, method: 'GET' | 'POST'): Promise<Attempt> {
    const doFetch = this.#options.fetch ?? fetch;
    try {
      const response = await doFetch(authorized.url, {
        method,
        headers: authorized.headers,
        ...(authorized.body !== undefined ? { body: authorized.body } : {}),
        // A redirect could carry credential headers to another host.
        redirect: 'manual',
        signal: AbortSignal.timeout(this.#options.timeoutMs ?? 15_000),
      });
      const body = await readBody(response, this.#options.maxBodyBytes ?? 8 * 1024 * 1024);
      const byStatus = classifyStatus(response.status);
      // A 2xx is only OK if the body agrees, for providers that report errors inside it.
      const verdict = byStatus === 'OK' && provider.readEnvelope ? provider.readEnvelope(body) : null;
      return {
        info: {
          outcome: verdict?.outcome ?? byStatus,
          httpStatus: response.status,
          retryAfterMs: parseRetryAfterMs(response.headers.get('retry-after'), this.#now()),
        },
        body,
        contentType: response.headers.get('content-type'),
        errorClass: verdict?.errorClass ?? null,
        errorDetail: verdict ? this.#options.redact(verdict.errorDetail).slice(0, 1000) : null,
      };
    } catch (error) {
      if (error instanceof ResponseTooLargeError) {
        return failed('RESPONSE_TOO_LARGE', 'ResponseTooLarge', error.message);
      }
      const classified = classifyFetchError(error);
      return failed(classified.outcome, classified.errorClass, this.#options.redact(classified.message));
    }
  }
}

function failed(outcome: RequestOutcome, errorClass: string, errorDetail: string): Attempt {
  return {
    info: { outcome, httpStatus: null, retryAfterMs: null },
    body: null,
    contentType: null,
    errorClass,
    errorDetail: errorDetail.slice(0, 1000),
  };
}

function notSent(outcome: RequestOutcome, detail: string): ProviderResult {
  return { outcome, httpStatus: null, body: null, payloadSha256: null, rawObservationId: null, detail };
}
