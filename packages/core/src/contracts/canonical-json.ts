/**
 * JSON with object keys sorted at every level, so two values that mean the
 * same thing serialise to the same text and hash the same. Array order is
 * kept: it is part of the meaning. Like JSON.stringify, undefined members are
 * left out and a value with toJSON (a Date) is serialised through it.
 */
export function canonicalJson(value: unknown): string {
  if (value !== null && typeof value === 'object' && typeof (value as { toJSON?: unknown }).toJSON === 'function') {
    return canonicalJson((value as { toJSON: () => unknown }).toJSON());
  }
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item === undefined ? null : item)).join(',')}]`;
  const members = Object.entries(value)
    .filter(([, member]) => member !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${members.map(([key, member]) => `${JSON.stringify(key)}:${canonicalJson(member)}`).join(',')}}`;
}
