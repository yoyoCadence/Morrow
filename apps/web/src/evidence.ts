import type { RawObservationView } from '@morrow/core';
import type { Tone } from './status.js';

const ASSET_ID = /^([a-z0-9-]+):([a-z0-9-]+):(.+)$/;

/**
 * A subject short enough for a table cell: an asset id keeps its network and
 * the ends of its mint ("solana · So11…1112"); anything else is shown as is.
 * The full subject is always available as a tooltip.
 */
export function shortSubject(subject: string): string {
  const asset = ASSET_ID.exec(subject);
  if (!asset?.[3] || subject.startsWith('system:') || subject.startsWith('provider:') || subject.startsWith('portfolio:')) return subject;
  const reference = asset[3];
  const short = reference.length > 12 ? `${reference.slice(0, 4)}…${reference.slice(-4)}` : reference;
  return `${asset[1]} · ${short}`;
}

/** The raw observation an evidence reference points to (`raw_observation:1234`), or null for any other kind. */
export function observationIdOf(ref: string): string | null {
  const match = /^raw_observation:([1-9]\d{0,18})$/.exec(ref);
  return match?.[1] ?? null;
}

/** OK is good; a request the source answered with a problem is a warning; no answer or no access is bad. */
export function outcomeTone(outcome: RawObservationView['outcome']): Tone {
  if (outcome === 'OK') return 'good';
  if (outcome === 'NOT_FOUND' || outcome === 'CLIENT_ERROR' || outcome === 'RATE_LIMITED' || outcome === 'RESPONSE_TOO_LARGE') return 'warn';
  if (outcome === 'CREDENTIAL_MISSING' || outcome === 'ENDPOINT_UNVERIFIED' || outcome === 'QUOTA_HARD_STOP' || outcome === 'SUPPRESSED') {
    return 'neutral';
  }
  return 'bad';
}

/** "812 B", "52.6 KB", "1.2 MB". Powers of 1024, like the storage report. */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** A JSON value laid out for reading. */
export function prettyJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

/**
 * Indents JSON text without parsing it into values: every number and string
 * is copied exactly as received. Parsing and re-serialising would rewrite
 * evidence: 0.00000001234 would come back as 1.234e-8, and integers beyond
 * 2^53 would lose digits.
 */
export function indentJson(text: string): string {
  let out = '';
  let depth = 0;
  let inString = false;
  let escaped = false;
  const newline = (): string => `\n${'  '.repeat(depth)}`;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i] as string;
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === ' ' || ch === '\n' || ch === '\r' || ch === '\t') continue;
    if (ch === '"') {
      inString = true;
      out += ch;
    } else if (ch === '{' || ch === '[') {
      const close = ch === '{' ? '}' : ']';
      // An empty object or array stays on one line.
      let next = i + 1;
      while (next < text.length && /\s/.test(text[next] as string)) next += 1;
      if (text[next] === close) {
        out += ch + close;
        i = next;
        continue;
      }
      depth += 1;
      out += ch + newline();
    } else if (ch === '}' || ch === ']') {
      depth -= 1;
      out += newline() + ch;
    } else if (ch === ',') {
      out += `,${newline()}`;
    } else if (ch === ':') {
      out += ': ';
    } else {
      out += ch;
    }
  }
  return out;
}

/**
 * A response body laid out for reading: valid JSON is indented (losslessly,
 * see `indentJson`), anything else is shown exactly as received. A cut-off
 * body is never touched, since half a JSON document is not JSON.
 */
export function prettyBody(text: string, truncated: boolean): string {
  if (truncated) return text;
  try {
    JSON.parse(text);
  } catch {
    return text;
  }
  return indentJson(text);
}
