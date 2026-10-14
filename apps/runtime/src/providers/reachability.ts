import { lookup as dnsLookup } from 'node:dns/promises';
import tls from 'node:tls';
import { TLS_ERROR_CODES } from './client.js';
import { CAPABILITIES } from './registry.js';

/*
 * Can this machine reach the providers' hosts at all (FT-05, `morrow doctor
 * --network`)? Resolves each host and completes a TLS handshake, verifying
 * the certificate the way the worker's requests do. No HTTP request is sent:
 * nothing is asked of the provider, no credential leaves the machine, and no
 * quota or rate limit is touched.
 */

export type Reachability = 'OK' | 'DNS_FAILED' | 'CONNECT_FAILED' | 'TIMEOUT' | 'TLS_UNTRUSTED' | 'TLS_FAILED';

export interface HostCheck {
  readonly host: string;
  readonly result: Reachability;
  /** The error code behind a failure, for example ENOTFOUND or SELF_SIGNED_CERT_IN_CHAIN; null when OK. */
  readonly code: string | null;
  readonly durationMs: number;
}

/** The hosts the worker sends requests to: every confirmed endpoint's origin, once each. */
export function providerHosts(): string[] {
  const hosts = new Set<string>();
  for (const capability of CAPABILITIES) if (capability.probe) hosts.add(new URL(capability.probe.origin).hostname);
  return [...hosts].sort();
}

export interface HostCheckOptions {
  readonly port?: number;
  readonly timeoutMs?: number;
  /** Replaces DNS resolution; for tests. */
  readonly lookup?: (host: string) => Promise<string>;
  /** Extra trusted certificates; for tests. The system's are used otherwise, as for every request. */
  readonly ca?: string;
}

const codeOf = (error: unknown): string | null =>
  typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string' ? error.code : null;

/** What a failed handshake means. A certificate that does not verify is TLS_UNTRUSTED, as for the worker's requests. */
export function classifyHandshakeError(error: unknown): Reachability {
  const code = codeOf(error);
  if (code !== null && TLS_ERROR_CODES.has(code)) return 'TLS_UNTRUSTED';
  if (code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'EHOSTUNREACH' || code === 'ENETUNREACH') return 'CONNECT_FAILED';
  if (code === 'ETIMEDOUT') return 'TIMEOUT';
  return 'TLS_FAILED';
}

/**
 * One deadline covers the whole check, the DNS lookup included: a resolver
 * that stalls is exactly what this is meant to find, so it must not hold the
 * check for the operating system's own, much longer, timeout.
 */
export function checkHost(host: string, options: HostCheckOptions = {}): Promise<HostCheck> {
  const started = performance.now();
  const timeoutMs = options.timeoutMs ?? 5_000;
  return new Promise<HostCheck>((resolve) => {
    let settled = false;
    let resolved = false;
    let socket: tls.TLSSocket | null = null;
    const settle = (result: Reachability, code: string | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket?.destroy();
      resolve({ host, result, code, durationMs: Math.round(performance.now() - started) });
    };
    // ETIMEOUT is what Node's resolver reports for a lookup that took too long.
    const timer = setTimeout(() => (resolved ? settle('TIMEOUT', null) : settle('DNS_FAILED', 'ETIMEOUT')), timeoutMs);

    const lookup = options.lookup ?? (async (name: string) => (await dnsLookup(name)).address);
    lookup(host).then(
      (address) => {
        resolved = true;
        if (settled) return;
        const connection = tls.connect({
          host: address,
          port: options.port ?? 443,
          // The certificate is checked against the name, not the address.
          servername: host,
          ...(options.ca !== undefined ? { ca: options.ca } : {}),
        });
        socket = connection;
        connection.once('secureConnect', () => {
          // rejectUnauthorized is on, so an unverified certificate fails with an error instead; this is a second guard.
          if (connection.authorized) settle('OK', null);
          else settle('TLS_UNTRUSTED', String(connection.authorizationError ?? 'UNAUTHORIZED'));
        });
        connection.once('error', (error) => settle(classifyHandshakeError(error), codeOf(error)));
      },
      (error: unknown) => settle('DNS_FAILED', codeOf(error)),
    );
  });
}

/** Checks every host at once; each has its own timeout. */
export function checkHosts(hosts: readonly string[], options: HostCheckOptions = {}): Promise<HostCheck[]> {
  return Promise.all(hosts.map((host) => checkHost(host, options)));
}
