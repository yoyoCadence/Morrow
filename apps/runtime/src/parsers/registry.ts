import { dexscreenerTokensParser } from './dexscreener-tokens.js';
import type { RawParser } from './types.js';

/** Every parser, keyed by the provider capability whose responses it reads. */
const PARSERS: readonly RawParser[] = [dexscreenerTokensParser];

/** The parser for a capability's responses, or null when nothing parses them yet. */
export function parserFor(provider: string, capability: string): RawParser | null {
  return PARSERS.find((parser) => parser.provider === provider && parser.capability === capability) ?? null;
}
