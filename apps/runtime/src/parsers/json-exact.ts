/** A JSON number, kept as the exact text the source sent. */
export class JsonNumber {
  constructor(readonly source: string) {}
}

/**
 * Parses JSON without letting any number pass through a float: every number
 * becomes a JsonNumber holding its source text, so `0.1234567890123456789`
 * keeps every digit. Relies on the reviver's source-text access (Node 24).
 */
export function parseJsonExact(text: string): unknown {
  return JSON.parse(text, (_key: string, value: unknown, context?: { source?: string }) => {
    if (typeof value !== 'number') return value;
    if (typeof context?.source !== 'string') {
      throw new Error('JSON.parse source text access is not available in this runtime');
    }
    return new JsonNumber(context.source);
  });
}

/** What to hand to the decimal parser: a number's source text, anything else unchanged. */
export function scalarOf(value: unknown): unknown {
  return value instanceof JsonNumber ? value.source : value;
}

export function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof JsonNumber);
}

/** A member of an object, or undefined when the value is not an object. */
export function member(value: unknown, key: string): unknown {
  return isJsonObject(value) ? value[key] : undefined;
}
