/**
 * A real DEX Screener response, stored as evidence by the first live probe.
 *
 * Request:  GET https://api.dexscreener.com/tokens/v1/solana/So11111111111111111111111111111111111111112
 * Received: 2026-10-05T13:53:18.133Z (raw_observation 1)
 * SHA-256:  9dd432b164f6259784cec74eb1a31b58b82f0e373fd2e80fa397d49cc8932892
 *
 * Kept byte for byte; the parser tests check the hash. Do not edit.
 */
export const WSOL_TOKENS_RESPONSE = {
  observedAt: '2026-10-05T13:53:18.133Z',
  sha256: '9dd432b164f6259784cec74eb1a31b58b82f0e373fd2e80fa397d49cc8932892',
  body: "[{\"chainId\":\"solana\",\"dexId\":\"orca\",\"url\":\"https://dexscreener.com/solana/czfq3xzzdmsdgduyrnltrhgc47cxcztlg4crryfu44ze\",\"pairAddress\":\"Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE\",\"labels\":[\"wp\"],\"baseToken\":{\"address\":\"So11111111111111111111111111111111111111112\",\"name\":\"Wrapped SOL\",\"symbol\":\"SOL\"},\"quoteToken\":{\"address\":\"EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v\",\"name\":\"USD Coin\",\"symbol\":\"USDC\"},\"priceNative\":\"120.7831\",\"priceUsd\":\"120.78\",\"txns\":{\"m5\":{\"buys\":151,\"sells\":245},\"h1\":{\"buys\":2639,\"sells\":1524},\"h6\":{\"buys\":10794,\"sells\":8199},\"h24\":{\"buys\":39938,\"sells\":33198}},\"volume\":{\"h24\":94425154.75,\"h6\":23991492.34,\"h1\":7063671.41,\"m5\":1204154.8},\"priceChange\":{\"m5\":0.02,\"h1\":0.32,\"h6\":-0.69,\"h24\":-0.84},\"liquidity\":{\"usd\":30663136.63,\"base\":136853,\"quote\":14133577},\"pairCreatedAt\":1688106058000,\"info\":{\"imageUrl\":\"https://cdn.dexscreener.com/cms/images/fcfb87378d3198fe753ca08ba51a5552a84f34cf48cd09d83971aa195bdf00d2?width=800&height=800&quality=95&format=auto\",\"header\":\"https://cdn.dexscreener.com/cms/images/7a8b9d77ffff37a36144cdebff51443a7c35bd737e8f327fc03f1121357731dd?width=1500&height=500&quality=95&format=auto\",\"openGraph\":\"https://cdn.dexscreener.com/token-images/og/solana/So11111111111111111111111111111111111111112?timestamp=1791208200000\",\"websites\":[{\"url\":\"https://solana.com\",\"label\":\"Website\"}],\"socials\":[{\"url\":\"https://x.com/solana\",\"type\":\"twitter\"}]}}]",
} as const;
