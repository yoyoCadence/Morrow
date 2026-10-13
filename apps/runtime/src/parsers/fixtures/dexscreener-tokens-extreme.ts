import { WSOL_TOKENS_RESPONSE } from './dexscreener-tokens-wsol.js';

/** Another real Solana address, used as the second pool. */
export const EXTREME_POOL = '83v8iPyZihDEjDdY8RdZddyZNyUtXngz69Lgo9Kt5d6d';

/**
 * A two-pair response: the real wrapped SOL pair, then a copy of it at
 * another pool whose numbers are valid JSON but cannot be carried by the
 * contract (a 97-digit price, `1e-120`, `1e+100`). Built by exact text edits
 * of the stored response, so the numbers reach the parser exactly as written.
 */
export function bodyWithExtremePair(): string {
  const original = WSOL_TOKENS_RESPONSE.body.slice(1, -1);
  const edits: [string, string][] = [
    ['"pairAddress":"Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE"', `"pairAddress":"${EXTREME_POOL}"`],
    ['"priceNative":"120.7831"', `"priceNative":"${'9'.repeat(97)}"`],
    ['"priceUsd":"120.78"', '"priceUsd":"1e-120"'],
    ['"m5":{"buys":151', '"m5":{"buys":1e+100'],
    ['"liquidity":{"usd":30663136.63', '"liquidity":{"usd":1e+100'],
  ];
  let extreme = original;
  for (const [from, to] of edits) {
    if (extreme.split(from).length !== 2) throw new Error(`fixture edit "${from}" does not match exactly once`);
    extreme = extreme.replace(from, to);
  }
  return `[${original},${extreme}]`;
}
