import { readOkxEnvelope } from './okx-envelope.js';
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
    // Free key: 1 request/s (developers.jup.ag/docs/portal/plans). The
    // blueprint caps us at 30/min, evenly spaced.
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
    // Documented limits are 60 or 300 requests/min depending on the endpoint.
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
    readEnvelope: readOkxEnvelope,
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
    // Free plan: 10 RPC requests/s (helius.dev/docs/billing/plans). DAS and
    // Enhanced APIs allow only 2/s; nothing calls them yet, and they would need
    // slower spacing than this.
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

// Probes need a token every endpoint knows. Wrapped SOL and USDC are permanent.
const WRAPPED_SOL_MINT = 'So11111111111111111111111111111111111111112';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

const JUPITER_ORIGIN = 'https://api.jup.ag';
const OKX_ORIGIN = 'https://web3.okx.com';
/** OKX `chainIndex` for Solana. */
const OKX_SOLANA = '501';
/** Which OKX endpoints draw from the Basic and which from the Premium allowance. */
const OKX_PRICING = 'https://web3.okx.com/onchainos/dev-docs/market/market-api-fee';

function get(origin: string, path: string, query?: Readonly<Record<string, string>>): RequestSpec {
  return { method: 'GET', origin, path, ...(query !== undefined ? { query } : {}) };
}

function checked(...sources: string[]): string {
  return `Checked against ${sources.join(' and ')} on 2026-10-05.`;
}

/**
 * Every provider capability the blueprint depends on, with the endpoint behind
 * it. A capability with `probe: null` is reported as ENDPOINT_UNVERIFIED and
 * never called.
 */
export const CAPABILITIES: readonly CapabilityDefinition[] = [
  // Jupiter: discovery of unknown mints, and executable quotes.
  {
    provider: 'jupiter',
    capability: 'tokens.recent',
    quotaBucket: null,
    units: 1,
    probe: get(JUPITER_ORIGIN, '/tokens/v2/recent'),
    docVerified: true,
    note:
      checked('https://developers.jup.ag/docs/tokens/token-information') +
      ' "Recent" means the first pool was created recently, not the mint.',
  },
  {
    provider: 'jupiter',
    capability: 'tokens.toptrending',
    quotaBucket: null,
    units: 1,
    probe: get(JUPITER_ORIGIN, '/tokens/v2/toptrending/5m'),
    docVerified: true,
    note: checked('https://developers.jup.ag/docs/tokens/token-information') + ' Intervals: 5m, 1h, 6h, 24h.',
  },
  {
    provider: 'jupiter',
    capability: 'tokens.toporganicscore',
    quotaBucket: null,
    units: 1,
    probe: get(JUPITER_ORIGIN, '/tokens/v2/toporganicscore/5m'),
    docVerified: true,
    note: checked('https://developers.jup.ag/docs/tokens/token-information') + ' Intervals: 5m, 1h, 6h, 24h.',
  },
  {
    provider: 'jupiter',
    capability: 'swap.quote',
    quotaBucket: null,
    units: 1,
    // 0.001 SOL to USDC. Without `taker`, Swap V2 /order returns a quote with
    // `transaction: null`. Never add `taker`: with it Jupiter assembles a
    // transaction to sign. /swap/v1/quote is deprecated.
    probe: get(JUPITER_ORIGIN, '/swap/v2/order', { inputMint: WRAPPED_SOL_MINT, outputMint: USDC_MINT, amount: '1000000' }),
    docVerified: true,
    note: checked('https://developers.jup.ag/docs/swap/order') + ' Quote only: no `taker`, so no transaction.',
  },

  // DEX Screener: market snapshots.
  {
    provider: 'dexscreener',
    capability: 'market.tokens',
    quotaBucket: null,
    units: 1,
    probe: get('https://api.dexscreener.com', `/tokens/v1/solana/${WRAPPED_SOL_MINT}`),
    docVerified: true,
    note: checked('https://docs.dexscreener.com/api/reference') + ' Up to 30 comma-separated addresses; 300 requests/min.',
  },

  // OKX: discovery lists, trades, holders and clusters. Each endpoint draws
  // from the Basic or the Premium monthly allowance, as listed on the pricing page.
  {
    provider: 'okx',
    capability: 'discovery.memepump',
    quotaBucket: 'premium',
    units: 1,
    // The blueprint polls NEW, MIGRATING and MIGRATED; one stage shows entitlement.
    probe: get(OKX_ORIGIN, '/api/v6/dex/market/memepump/tokenList', { chainIndex: OKX_SOLANA, stage: 'NEW' }),
    docVerified: true,
    note: checked('https://web3.okx.com/onchainos/dev-docs/market/market-memepump-get-token-list', OKX_PRICING),
  },
  {
    provider: 'okx',
    capability: 'discovery.hot_token',
    quotaBucket: 'basic',
    units: 1,
    // rankingType 4 is "Trending"; 5 is "X mentioned".
    probe: get(OKX_ORIGIN, '/api/v6/dex/market/token/hot-token', { rankingType: '4', chainIndex: OKX_SOLANA }),
    docVerified: true,
    note: checked('https://web3.okx.com/onchainos/dev-docs/market/market-token-hot-token', OKX_PRICING),
  },
  {
    provider: 'okx',
    capability: 'market.trades',
    quotaBucket: 'basic',
    units: 1,
    probe: get(OKX_ORIGIN, '/api/v6/dex/market/trades', { chainIndex: OKX_SOLANA, tokenContractAddress: WRAPPED_SOL_MINT }),
    docVerified: true,
    note: checked('https://web3.okx.com/onchainos/dev-docs/market/market-trades', OKX_PRICING),
  },
  {
    provider: 'okx',
    capability: 'token.holders',
    quotaBucket: 'premium',
    units: 1,
    probe: get(OKX_ORIGIN, '/api/v6/dex/market/token/holder', { chainIndex: OKX_SOLANA, tokenContractAddress: WRAPPED_SOL_MINT }),
    docVerified: true,
    note:
      checked('https://web3.okx.com/onchainos/dev-docs/market/market-token-holder', OKX_PRICING) +
      ' At most 100 holders. holdPercent is on a 0-100 scale.',
  },
  {
    provider: 'okx',
    capability: 'token.cluster_overview',
    quotaBucket: 'premium',
    units: 1,
    probe: get(OKX_ORIGIN, '/api/v6/dex/market/token/cluster/overview', {
      chainIndex: OKX_SOLANA,
      tokenContractAddress: WRAPPED_SOL_MINT,
    }),
    docVerified: true,
    note:
      checked('https://web3.okx.com/onchainos/dev-docs/market/market-token-cluster-overview', OKX_PRICING) +
      ' Percent fields are on a 0-100 scale and may be "--".',
  },
  {
    provider: 'okx',
    capability: 'token.cluster_list',
    quotaBucket: 'premium',
    units: 1,
    probe: get(OKX_ORIGIN, '/api/v6/dex/market/token/cluster/list', { chainIndex: OKX_SOLANA, tokenContractAddress: WRAPPED_SOL_MINT }),
    docVerified: true,
    note:
      checked('https://web3.okx.com/onchainos/dev-docs/market/market-token-cluster-list', OKX_PRICING) +
      ' Top 100 clusters among the top 300 holders. holdingPercent is a 0-1 fraction.',
  },
  {
    provider: 'okx',
    capability: 'token.cluster_top_holders',
    quotaBucket: 'premium',
    units: 1,
    // rangeFilter 1, 2, 3 = top 10, 50, 100. An aggregate, not an address export.
    probe: get(OKX_ORIGIN, '/api/v6/dex/market/token/cluster/top-holders', {
      chainIndex: OKX_SOLANA,
      tokenContractAddress: WRAPPED_SOL_MINT,
      rangeFilter: '1',
    }),
    docVerified: true,
    note:
      checked('https://web3.okx.com/onchainos/dev-docs/market/market-token-cluster-top-holders', OKX_PRICING) +
      ' holdingPercent is a 0-1 fraction.',
  },

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
    docVerified: true,
    note:
      checked('https://www.helius.dev/docs/api-reference/rpc/http/gethealth', 'https://www.helius.dev/docs/billing/credits') +
      ' Standard RPC calls cost 1 credit.',
  },
];
