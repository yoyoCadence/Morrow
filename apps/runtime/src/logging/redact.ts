export const REDACTED = '[REDACTED]';

/** Below this length a value is too likely to match ordinary text, so only the pattern rules protect it. */
const MIN_VALUE_LENGTH = 6;

// user:password@ inside any URL.
const URL_USERINFO = /(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@"']+:)[^\s@"']+@/gi;
// Credential-looking query parameters, for example ?api-key=...
const SECRET_QUERY_PARAM = /([?&](?:api[-_]?key|access[-_]?token|token|key|secret|signature|passphrase)=)[^&\s"'\\]+/gi;

/**
 * Builds a function that removes secrets from text.
 *
 * Two layers: every known secret value is replaced wherever it appears (also
 * in its JSON-escaped and URL-encoded forms), and credential-shaped patterns
 * are replaced even when the value was not registered.
 */
export function createRedactor(secrets: Iterable<string>): (text: string) => string {
  const variants = new Set<string>();
  for (const secret of secrets) {
    if (secret.length < MIN_VALUE_LENGTH) continue;
    variants.add(secret);
    variants.add(JSON.stringify(secret).slice(1, -1));
    variants.add(encodeURIComponent(secret));
  }
  // Longest first, so a secret that contains another is removed whole.
  const ordered = [...variants].sort((a, b) => b.length - a.length);

  return (text: string): string => {
    let result = text;
    for (const value of ordered) {
      if (result.includes(value)) result = result.split(value).join(REDACTED);
    }
    return result.replace(URL_USERINFO, `$1${REDACTED}@`).replace(SECRET_QUERY_PARAM, `$1${REDACTED}`);
  };
}
