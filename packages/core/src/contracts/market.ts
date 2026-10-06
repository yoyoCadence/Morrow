import { z } from 'zod';
import { AssetIdString, isSolanaAddress } from './asset-id.js';
import { observedSchema } from './observed.js';
import { DecimalString, UIntString, UtcTimestamp } from './primitives.js';

/** Rolling windows market sources report activity over. */
export const MARKET_WINDOWS = ['m5', 'h1', 'h6', 'h24'] as const;
export type MarketWindow = (typeof MARKET_WINDOWS)[number];

const SolanaAddress = z.string().refine(isSolanaAddress, 'expected a Solana address');
const ObservedDecimal = observedSchema(DecimalString);
const ObservedCount = observedSchema(UIntString);

function perWindow<T extends z.ZodType>(schema: T) {
  return z.strictObject({ m5: schema, h1: schema, h6: schema, h24: schema });
}

/** Domain, action and payload version of the event that carries a PairSnapshot. */
export const PAIR_SNAPSHOT_EVENT = { domain: 'market', action: 'pair.snapshot', payloadVersion: 1 } as const;

/**
 * One pool's market state as an indexer reported it when we observed it.
 *
 * A snapshot is not an executable price: it is what an aggregator shows, not a
 * quote for a given size. Two indexers reading the same pool are not
 * independent confirmation of each other.
 *
 * Every number is an `Observed` value. A field the source left out, or sent in
 * a unit we have not confirmed, is UNKNOWN with a reason, never zero.
 */
export const PairSnapshot = z.strictObject({
  pool_address: SolanaAddress,
  /** The DEX the pool belongs to, as the source names it. */
  venue: observedSchema(z.string().min(1).max(64)),
  /** The source's labels for the pool type, such as "wp". Empty when there are none. */
  venue_labels: z.array(z.string().min(1).max(32)).max(16),
  base_asset: AssetIdString,
  quote_asset: observedSchema(AssetIdString),
  price_usd: ObservedDecimal,
  /** Price of one base token in quote tokens. */
  price_in_quote: ObservedDecimal,
  liquidity_usd: ObservedDecimal,
  volume_usd: perWindow(ObservedDecimal),
  /** Price change over each window as a fraction: 0.01 is 1%. */
  price_change: perWindow(ObservedDecimal),
  txns: perWindow(z.strictObject({ buys: ObservedCount, sells: ObservedCount })),
  fdv_usd: ObservedDecimal,
  market_cap_usd: ObservedDecimal,
  /** When the pool was created, according to the source. Not the time of the snapshot. */
  pool_created_at: observedSchema(UtcTimestamp),
});
export type PairSnapshot = z.infer<typeof PairSnapshot>;
