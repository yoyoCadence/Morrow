import type { ProviderCredentials } from '../config/config.js';

export type ProviderId = 'jupiter' | 'dexscreener' | 'okx' | 'helius';

/**
 * A request as it is recorded: no credentials anywhere in it. Authentication
 * is added by the provider's `authorize` at send time and never stored.
 */
export interface RequestSpec {
  readonly method: 'GET' | 'POST';
  /** Scheme and host, for example `https://api.example.com`. */
  readonly origin: string;
  /** Path beginning with `/`. */
  readonly path: string;
  readonly query?: Readonly<Record<string, string>>;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
}

/** A request ready to send. May contain credentials; must never be logged or stored. */
export interface AuthorizedRequest {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
}

export interface ProviderDefinition {
  readonly id: ProviderId;
  /**
   * Providers that read the same upstream data share a group and do not count
   * as independent confirmation of each other.
   */
  readonly group: string;
  /** Minimum spacing between requests, enforced in-process by the worker. */
  readonly minIntervalMs: number;
  /**
   * True when the provider has a monthly allowance. Every call to a metered
   * provider must name the quota bucket it draws from.
   */
  readonly metered: boolean;
  /**
   * Adds authentication. Returns null when the credentials this provider
   * needs are not configured.
   */
  authorize(spec: RequestSpec, credentials: ProviderCredentials, now: Date): AuthorizedRequest | null;
}

export interface CapabilityDefinition {
  readonly provider: ProviderId;
  /** Stable name of what the endpoint gives us, for example `tokens.recent`. */
  readonly capability: string;
  /** Metered bucket this capability draws from, or null if the provider has no monthly allowance. */
  readonly quotaBucket: string | null;
  /** Budget units one call costs. */
  readonly units: number;
  /**
   * A minimal request that shows whether our credentials can use this
   * capability. Null while the endpoint has not been confirmed.
   */
  readonly probe: RequestSpec | null;
  /** True once the endpoint was checked against the provider's own documentation. */
  readonly docVerified: boolean;
  readonly note: string;
}

/** Path plus sorted query string: the part of a URL that request signing covers. */
export function pathWithQuery(spec: RequestSpec): string {
  const entries = Object.entries(spec.query ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  if (entries.length === 0) return spec.path;
  const query = entries.map(([name, value]) => `${encodeURIComponent(name)}=${encodeURIComponent(value)}`).join('&');
  return `${spec.path}?${query}`;
}

/** The credential-free URL that is safe to store and log. */
export function publicUrl(spec: RequestSpec): string {
  return `${spec.origin}${pathWithQuery(spec)}`;
}
