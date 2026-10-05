import { signOkxRequest } from './okx-signing.js';
import {
  pathWithQuery,
  publicUrl,
  type CapabilityDefinition,
  type ProviderDefinition,
  type ProviderId,
  type RequestSpec,
} from './types.js';

const JSON_HEADERS = { accept: 'application/json' } as const;

export const PROVIDERS: Readonly<Record<ProviderId, ProviderDefinition>> = {
  jupiter: {
    id: 'jupiter',
    group: 'jupiter',
    // Blueprint: free key allows 1 request/s; we cap at 30/min, evenly spaced.
    minIntervalMs: 2_000,
    metered: false,
    authorize(spec, credentials) {
      if (!credentials.jupiter) return null;
      return {
        url: publicUrl(spec),
        headers: { ...JSON_HEADERS, ...spec.headers, 'x-api-key': credentials.jupiter.apiKey },
        ...(spec.body !== undefined ? { body: spec.body } : {}),
      };
    },
  },
  dexscreener: {
    id: 'dexscreener',
    group: 'dexscreener',
    minIntervalMs: 1_000,
    metered: false,
    authorize(spec) {
      // Keyless public API.
      return {
        url: publicUrl(spec),
        headers: { ...JSON_HEADERS, ...spec.headers },
        ...(spec.body !== undefined ? { body: spec.body } : {}),
      };
    },
  },
  okx: {
    id: 'okx',
    group: 'okx',
    minIntervalMs: 1_000,
    metered: true,
    authorize(spec, credentials, now) {
      if (!credentials.okx) return null;
      const timestamp = now.toISOString();
      const signature = signOkxRequest({
        timestamp,
        method: spec.method,
        requestPath: pathWithQuery(spec),
        body: spec.body ?? '',
        secretKey: credentials.okx.secretKey,
      });
      return {
        url: publicUrl(spec),
        headers: {
          ...JSON_HEADERS,
          ...spec.headers,
          'OK-ACCESS-KEY': credentials.okx.apiKey,
          'OK-ACCESS-SIGN': signature,
          'OK-ACCESS-TIMESTAMP': timestamp,
          'OK-ACCESS-PASSPHRASE': credentials.okx.passphrase,
        },
        ...(spec.body !== undefined ? { body: spec.body } : {}),
      };
    },
  },
  helius: {
    id: 'helius',
    group: 'helius',
    // Blueprint: free tier allows 10 requests/s.
    minIntervalMs: 250,
    metered: true,
    authorize(spec, credentials) {
      if (!credentials.helius) return null;
      // Helius takes the key as a query parameter. It is appended here, after
      // the storable URL has already been derived from the spec.
      const separator = pathWithQuery(spec).includes('?') ? '&' : '?';
      return {
        url: `${publicUrl(spec)}${separator}api-key=${encodeURIComponent(credentials.helius.apiKey)}`,
        headers: { ...JSON_HEADERS, ...spec.headers },
        ...(spec.body !== undefined ? { body: spec.body } : {}),
      };
    },
  },
};

const WRAPPED_SOL_MINT = 'So11111111111111111111111111111111111111112';

const UNVERIFIED_NOTE =
  'Endpoint recalled from provider documentation but not re-checked: the provider and its docs were ' +
  'unreachable from the build network on 2026-10-05. Verify before relying on it.';
const NO_ENDPOINT_NOTE =
  'Required by the blueprint. No endpoint is defined yet because the provider documentation could not be ' +
  'read from the build network on 2026-10-05.';

function get(origin: string, path: string): RequestSpec {
  return { method: 'GET', origin, path };
}

/**
 * Every provider capability the blueprint depends on, with what is known about
 * its endpoint. A capability with `probe: null` is reported as
 * ENDPOINT_UNVERIFIED and never called.
 */
export const CAPABILITIES: readonly CapabilityDefinition[] = [
  // Jupiter: discovery of unknown mints, and executable quotes.
  {
    provider: 'jupiter',
    capability: 'tokens.recent',
    quotaBucket: null,
    units: 1,
    probe: get('https://api.jup.ag', '/tokens/v2/recent'),
    docVerified: false,
    note: UNVERIFIED_NOTE,
  },
  {
    provider: 'jupiter',
    capability: 'tokens.toptrending',
    quotaBucket: null,
    units: 1,
    probe: get('https://api.jup.ag', '/tokens/v2/toptrending/5m'),
    docVerified: false,
    note: UNVERIFIED_NOTE,
  },
  {
    provider: 'jupiter',
    capability: 'tokens.toporganicscore',
    quotaBucket: null,
    units: 1,
    probe: get('https://api.jup.ag', '/tokens/v2/toporganicscore/5m'),
    docVerified: false,
    note: UNVERIFIED_NOTE,
  },
  { provider: 'jupiter', capability: 'swap.quote', quotaBucket: null, units: 1, probe: null, docVerified: false, note: NO_ENDPOINT_NOTE },

  // DEX Screener: market snapshots.
  {
    provider: 'dexscreener',
    capability: 'market.tokens',
    quotaBucket: null,
    units: 1,
    probe: get('https://api.dexscreener.com', `/tokens/v1/solana/${WRAPPED_SOL_MINT}`),
    docVerified: false,
    note: UNVERIFIED_NOTE,
  },

  // OKX: discovery lists, trades, holders and clusters. Which of the Basic and
  // Premium buckets each endpoint draws from is unconfirmed, so no bucket is
  // assigned. The client refuses to call a metered provider without one.
  { provider: 'okx', capability: 'discovery.memepump', quotaBucket: null, units: 1, probe: null, docVerified: false, note: NO_ENDPOINT_NOTE },
  { provider: 'okx', capability: 'discovery.hot_token', quotaBucket: null, units: 1, probe: null, docVerified: false, note: NO_ENDPOINT_NOTE },
  { provider: 'okx', capability: 'market.trades', quotaBucket: null, units: 1, probe: null, docVerified: false, note: NO_ENDPOINT_NOTE },
  { provider: 'okx', capability: 'token.holders', quotaBucket: null, units: 1, probe: null, docVerified: false, note: NO_ENDPOINT_NOTE },
  { provider: 'okx', capability: 'token.cluster_overview', quotaBucket: null, units: 1, probe: null, docVerified: false, note: NO_ENDPOINT_NOTE },
  { provider: 'okx', capability: 'token.cluster_list', quotaBucket: null, units: 1, probe: null, docVerified: false, note: NO_ENDPOINT_NOTE },
  { provider: 'okx', capability: 'token.cluster_top_holders', quotaBucket: null, units: 1, probe: null, docVerified: false, note: NO_ENDPOINT_NOTE },

  // Helius: on-chain accounts and transactions.
  {
    provider: 'helius',
    capability: 'rpc.health',
    quotaBucket: 'credits',
    units: 1,
    probe: {
      method: 'POST',
      origin: 'https://mainnet.helius-rpc.com',
      path: '/',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getHealth' }),
    },
    docVerified: false,
    note: UNVERIFIED_NOTE,
  },
];
