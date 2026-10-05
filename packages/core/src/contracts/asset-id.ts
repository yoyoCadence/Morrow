import { z } from 'zod';

/**
 * Canonical asset identity: `namespace:network:reference`.
 *
 * For Solana the reference is the mint address. A symbol or name is never an
 * identity: many tokens share one symbol, and copycat mints rely on that.
 */
export interface AssetId {
  readonly namespace: 'solana';
  readonly network: 'mainnet-beta';
  readonly reference: string;
}

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** Number of bytes a base58 string decodes to, or null if it is not base58. */
export function base58DecodedLength(text: string): number | null {
  if (text.length === 0) return null;
  let value = 0n;
  for (const character of text) {
    const digit = BASE58_ALPHABET.indexOf(character);
    if (digit < 0) return null;
    value = value * 58n + BigInt(digit);
  }
  let bytes = 0;
  while (value > 0n) {
    value >>= 8n;
    bytes += 1;
  }
  // Each leading '1' encodes one leading zero byte.
  let leadingZeros = 0;
  for (const character of text) {
    if (character !== '1') break;
    leadingZeros += 1;
  }
  return bytes + leadingZeros;
}

/** True when the text is a base58 encoding of exactly 32 bytes, as every Solana address is. */
export function isSolanaAddress(text: string): boolean {
  return text.length >= 32 && text.length <= 44 && base58DecodedLength(text) === 32;
}

export function formatAssetId(id: AssetId): string {
  return `${id.namespace}:${id.network}:${id.reference}`;
}

/** Parses a canonical asset id. Throws on anything else, including a bare symbol. */
export function parseAssetId(text: string): AssetId {
  const parts = text.split(':');
  if (parts.length !== 3) {
    throw new Error(`Invalid asset id "${text}": expected namespace:network:reference`);
  }
  const [namespace, network, reference] = parts as [string, string, string];
  if (namespace !== 'solana' || network !== 'mainnet-beta') {
    throw new Error(`Invalid asset id "${text}": unsupported namespace or network`);
  }
  if (!isSolanaAddress(reference)) {
    throw new Error(`Invalid asset id "${text}": reference is not a Solana mint address`);
  }
  return { namespace, network, reference };
}

export function isAssetIdString(text: string): boolean {
  try {
    parseAssetId(text);
    return true;
  } catch {
    return false;
  }
}

export const AssetIdString = z.string().refine(isAssetIdString, 'expected an asset id like solana:mainnet-beta:<mint>');
export type AssetIdString = z.infer<typeof AssetIdString>;

export function solanaAssetId(mint: string): string {
  return formatAssetId(parseAssetId(`solana:mainnet-beta:${mint}`));
}
