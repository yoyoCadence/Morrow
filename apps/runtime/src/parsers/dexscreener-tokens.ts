import {
  isSolanaAddress,
  knownValue,
  MARKET_WINDOWS,
  PAIR_SNAPSHOT_EVENT,
  PairSnapshot,
  parseDecimal,
  SCHEMA_VERSION,
  solanaAssetId,
  unknownValue,
  type MarketWindow,
  type NewEvent,
  type Observed,
} from '@morrow/core';
import type { z } from 'zod';
import { isJsonObject, member, parseJsonExact, scalarOf } from './json-exact.js';
import type { ParseResult, QuarantinedField, RawParser, StoredObservation } from './types.js';

/**
 * DEX Screener `GET /tokens/v1/{chainId}/{tokenAddresses}`: an array of pairs.
 * Field meanings follow the provider's OpenAPI spec (docs.dexscreener.com,
 * checked 2026-10-05) and the response stored as raw_observation 1.
 *
 * Mapped with a confirmed unit: priceUsd, liquidity.usd (the key names the
 * unit), priceNative (price in quote tokens: 120.7831 for SOL/USDC when
 * priceUsd was 120.78), txns counts, pairCreatedAt (epoch milliseconds).
 *
 * Quarantined as UNIT_UNVERIFIED: volume, priceChange, fdv, marketCap. The
 * spec gives them no unit. They look like USD and percent, but reading a unit
 * off the size of a number is the guess this system does not make.
 *
 * Not read: url, info and boosts (untrusted promotional content), and
 * liquidity.base/quote (decimal-adjusted token amounts, not raw amounts).
 *
 * The response has no time of its own, so `event_time` is null; when we
 * received it is `observed_at`.
 */
export const DEXSCREENER_TOKENS_PARSER_VERSION = 'dexscreener-tokens@1';

/** Solana mainnet-beta launched in March 2020. An earlier pool creation time is not credible. */
const EARLIEST_CREDIBLE_MS = Date.UTC(2020, 0, 1);
const MAX_RAW_TEXT = 1000;

/** UNKNOWN reasons that mean there was nothing to interpret: not quarantined. */
const NOTHING_TO_INTERPRET = new Set(['MISSING', 'PLACEHOLDER']);

type NewEventInput = z.input<typeof NewEvent>;

/** Reads the fields of one pair, recording each value it will not interpret. */
class PairReader {
  constructor(
    private readonly recordRef: string,
    private readonly quarantined: QuarantinedField[],
  ) {}

  /** A non-negative amount in a confirmed unit. */
  amount(path: string, raw: unknown): Observed<string> {
    const parsed = parseDecimal(scalarOf(raw));
    if (parsed.state === 'KNOWN' && parsed.value.startsWith('-')) return this.#track(path, raw, unknownValue('NEGATIVE'));
    return this.#track(path, raw, parsed);
  }

  /** A number whose unit the provider does not document. */
  unitUnverified(path: string, raw: unknown): Observed<string> {
    const parsed = parseDecimal(scalarOf(raw));
    return this.#track(path, raw, parsed.state === 'KNOWN' ? unknownValue('UNIT_UNVERIFIED') : parsed);
  }

  count(path: string, raw: unknown): Observed<string> {
    const parsed = parseDecimal(scalarOf(raw));
    if (parsed.state === 'KNOWN' && !/^(0|[1-9]\d*)$/.test(parsed.value)) return this.#track(path, raw, unknownValue('NOT_A_COUNT'));
    return this.#track(path, raw, parsed);
  }

  text(path: string, raw: unknown, maxLength: number): Observed<string> {
    if (raw === undefined || raw === null) return unknownValue('MISSING');
    if (typeof raw !== 'string' || raw.trim() === '' || raw.length > maxLength) {
      return this.#track(path, raw, unknownValue('INVALID_TEXT'));
    }
    return knownValue(raw);
  }

  asset(path: string, raw: unknown): Observed<string> {
    if (raw === undefined || raw === null) return unknownValue('MISSING');
    if (typeof raw !== 'string' || !isSolanaAddress(raw)) return this.#track(path, raw, unknownValue('INVALID_ADDRESS'));
    return knownValue(solanaAssetId(raw));
  }

  labels(path: string, raw: unknown): string[] {
    if (raw === undefined || raw === null) return [];
    if (!Array.isArray(raw)) {
      this.#track(path, raw, unknownValue('NOT_AN_ARRAY'));
      return [];
    }
    const labels: string[] = [];
    raw.forEach((label, index) => {
      if (typeof label === 'string' && label.length >= 1 && label.length <= 32 && labels.length < 16) labels.push(label);
      else this.#track(`${path}[${index}]`, label, unknownValue('INVALID_LABEL'));
    });
    return labels;
  }

  /** Epoch milliseconds, which must fall between Solana's launch and shortly after we received the data. */
  timestampMs(path: string, raw: unknown, observedAt: Date): Observed<string> {
    const parsed = parseDecimal(scalarOf(raw));
    if (parsed.state !== 'KNOWN') return this.#track(path, raw, parsed);
    const ms = /^\d+$/.test(parsed.value) ? Number(parsed.value) : Number.NaN;
    if (!Number.isSafeInteger(ms)) return this.#track(path, raw, unknownValue('NOT_EPOCH_MS'));
    if (ms < EARLIEST_CREDIBLE_MS || ms > observedAt.getTime() + 86_400_000) {
      return this.#track(path, raw, unknownValue('OUT_OF_RANGE'));
    }
    return knownValue(new Date(ms).toISOString());
  }

  #track(path: string, raw: unknown, result: Observed<string>): Observed<string> {
    const quarantine =
      result.state === 'UNSUPPORTED' || (result.state === 'UNKNOWN' && !NOTHING_TO_INTERPRET.has(result.reason));
    if (quarantine) {
      this.quarantined.push({ recordRef: this.recordRef, fieldPath: path, rawValue: rawText(raw), reason: result.reason });
    }
    return result;
  }
}

function rawText(raw: unknown): string | null {
  const scalar = scalarOf(raw);
  if (typeof scalar === 'string') return scalar.slice(0, MAX_RAW_TEXT);
  if (typeof scalar === 'boolean') return String(scalar);
  return null;
}

function perWindow<T>(read: (window: MarketWindow) => T): Record<MarketWindow, T> {
  return Object.fromEntries(MARKET_WINDOWS.map((window) => [window, read(window)])) as Record<MarketWindow, T>;
}

function parseTokensResponse(observation: StoredObservation): ParseResult {
  const quarantined: QuarantinedField[] = [];
  const whole = (reason: string, rawValue: string | null): ParseResult => ({
    events: [],
    quarantined: [{ recordRef: '$', fieldPath: '$', rawValue, reason }],
  });

  let body: unknown;
  try {
    body = parseJsonExact(observation.body.toString('utf8'));
  } catch {
    return whole('INVALID_JSON', observation.body.toString('utf8').slice(0, MAX_RAW_TEXT));
  }
  if (!Array.isArray(body)) return whole('NOT_AN_ARRAY', null);

  const events: NewEventInput[] = [];
  const seenPools = new Set<string>();
  body.forEach((item, index) => {
    const at = `$[${index}]`;
    const reject = (path: string, raw: unknown, reason: string): void => {
      quarantined.push({ recordRef: at, fieldPath: path, rawValue: rawText(raw), reason });
    };
    if (!isJsonObject(item)) return reject(at, item, 'NOT_AN_OBJECT');

    // A pair we cannot identify cannot become a record at all.
    if (scalarOf(item['chainId']) !== 'solana') return reject(`${at}.chainId`, item['chainId'], 'UNSUPPORTED_CHAIN');
    const pool = item['pairAddress'];
    if (typeof pool !== 'string' || !isSolanaAddress(pool)) return reject(`${at}.pairAddress`, pool, 'INVALID_ADDRESS');
    const baseMint = member(item['baseToken'], 'address');
    if (typeof baseMint !== 'string' || !isSolanaAddress(baseMint)) {
      return reject(`${at}.baseToken.address`, baseMint, 'INVALID_ADDRESS');
    }
    // The same pool listed twice in one response is one fact.
    if (seenPools.has(pool)) return;
    seenPools.add(pool);

    const read = new PairReader(pool, quarantined);
    const payload = PairSnapshot.parse({
      pool_address: pool,
      venue: read.text(`${at}.dexId`, item['dexId'], 64),
      venue_labels: read.labels(`${at}.labels`, item['labels']),
      base_asset: solanaAssetId(baseMint),
      quote_asset: read.asset(`${at}.quoteToken.address`, member(item['quoteToken'], 'address')),
      price_usd: read.amount(`${at}.priceUsd`, item['priceUsd']),
      price_in_quote: read.amount(`${at}.priceNative`, item['priceNative']),
      liquidity_usd: read.amount(`${at}.liquidity.usd`, member(item['liquidity'], 'usd')),
      volume_usd: perWindow((w) => read.unitUnverified(`${at}.volume.${w}`, member(item['volume'], w))),
      price_change: perWindow((w) => read.unitUnverified(`${at}.priceChange.${w}`, member(item['priceChange'], w))),
      txns: perWindow((w) => ({
        buys: read.count(`${at}.txns.${w}.buys`, member(member(item['txns'], w), 'buys')),
        sells: read.count(`${at}.txns.${w}.sells`, member(member(item['txns'], w), 'sells')),
      })),
      fdv_usd: read.unitUnverified(`${at}.fdv`, item['fdv']),
      market_cap_usd: read.unitUnverified(`${at}.marketCap`, item['marketCap']),
      pool_created_at: read.timestampMs(`${at}.pairCreatedAt`, item['pairCreatedAt'], observation.observedAt),
    });

    events.push({
      schema_version: SCHEMA_VERSION,
      dedupe_key: `${DEXSCREENER_TOKENS_PARSER_VERSION}:raw_observation:${observation.id}:pool:${pool}`,
      domain: PAIR_SNAPSHOT_EVENT.domain,
      action: PAIR_SNAPSHOT_EVENT.action,
      subject: payload.base_asset,
      payload_version: PAIR_SNAPSHOT_EVENT.payloadVersion,
      payload,
      event_time: null,
      observed_at: observation.observedAt.toISOString(),
      provenance: {
        provider: observation.provider,
        provider_group: observation.providerGroup,
        parser_version: DEXSCREENER_TOKENS_PARSER_VERSION,
        raw_sha256: observation.payloadSha256,
        evidence_refs: [`raw_observation:${observation.id}`],
        slot: null,
        commitment: null,
        coverage: { completeness: 'COMPLETE' },
      },
      severity: 'INFO',
      confidence: null,
      causation_id: null,
      correlation_id: null,
    });
  });
  return { events, quarantined };
}

export const dexscreenerTokensParser: RawParser = {
  provider: 'dexscreener',
  capability: 'market.tokens',
  version: DEXSCREENER_TOKENS_PARSER_VERSION,
  parse: parseTokensResponse,
};
