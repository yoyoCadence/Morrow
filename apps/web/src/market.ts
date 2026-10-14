import { type Observed, shiftDecimal } from '@morrow/core';

/*
 * Formatting for the market snapshot page (FT-02). Values arrive as exact
 * decimal strings and are only ever re-spaced here, never turned into a
 * JavaScript number: a price shown with a digit changed would be a price
 * nobody observed.
 */

/**
 * A snapshot older than this is marked out of date on the page. A display
 * rule only: the stored snapshot does not change, and a strategy will set its
 * own limit on how old an input it accepts.
 */
export const SNAPSHOT_STALE_MS = 5 * 60_000;

export function isStale(observedAtIso: string, nowMs: number): boolean {
  return nowMs - Date.parse(observedAtIso) > SNAPSHOT_STALE_MS;
}

/** "30663136.63" becomes "30,663,136.63". Every digit is kept; anything that is not a plain decimal is returned as is. */
export function groupDigits(value: string): string {
  const match = /^(-?)(\d+)(\.\d+)?$/.exec(value);
  if (!match) return value;
  const [, sign = '', integer = '', fraction = ''] = match;
  return `${sign}${integer.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}${fraction}`;
}

/** A fraction as a percentage, exactly: "-0.0084" becomes "-0.84%", "0.0125" becomes "+1.25%". */
export function fractionAsPercent(value: string): string {
  const percent = shiftDecimal(value, 2);
  const sign = percent.startsWith('-') || percent === '0' ? '' : '+';
  return `${sign}${groupDigits(percent)}%`;
}

/** The ends of a long address, enough to recognise it: "Czfq…44zE". */
export function shortAddress(address: string): string {
  return address.length > 12 ? `${address.slice(0, 4)}…${address.slice(-4)}` : address;
}

/** The reference of an asset id and its namespace and network, shown on separate lines. */
export function assetParts(assetId: string): { reference: string; network: string } {
  const match = /^([a-z0-9-]+):([a-z0-9-]+):(.+)$/.exec(assetId);
  if (!match?.[3]) return { reference: assetId, network: '' };
  return { reference: match[3], network: `${match[1]}:${match[2]}` };
}

/** Why a value is not known, in the operator's words. The code itself is kept in the tooltip. */
const REASONS: Readonly<Record<string, string>> = {
  MISSING: '來源未提供',
  PLACEHOLDER: '來源標示為無資料',
  UNIT_UNVERIFIED: '單位未確認',
  NOT_NUMERIC: '不是數字',
  NOT_FINITE: '不是有限數值',
  NOT_A_SCALAR: '不是單一值',
  NEGATIVE: '出現負值',
  NOT_A_COUNT: '不是整數筆數',
  NOT_REPRESENTABLE: '超出可表示範圍',
  INVALID_TEXT: '文字無效',
  INVALID_ADDRESS: '地址無效',
  NOT_EPOCH_MS: '不是毫秒時間戳',
  OUT_OF_RANGE: '時間不合理',
};

export function reasonLabel(reason: string): string {
  // Own keys only: "constructor" is not a reason we have a label for.
  return Object.hasOwn(REASONS, reason) ? (REASONS[reason] ?? reason) : reason;
}

/** How one Observed value reads on the page. Only `known` shows a bare value; every other state says what it is. */
export type ObservedDisplay =
  | { readonly kind: 'known'; readonly text: string; readonly title: null }
  | { readonly kind: 'stale' | 'conflicting' | 'unknown'; readonly text: string; readonly title: string };

export function describeObserved<T>(observed: Observed<T>, format: (value: T) => string): ObservedDisplay {
  switch (observed.state) {
    case 'KNOWN':
      return { kind: 'known', text: format(observed.value), title: null };
    case 'STALE':
      return { kind: 'stale', text: `${format(observed.value)}（過時：${reasonLabel(observed.reason)}）`, title: `STALE · ${observed.reason}` };
    case 'CONFLICTING':
      return {
        kind: 'conflicting',
        text: `來源不一致（${observed.candidates.length} 個值）`,
        title: `CONFLICTING · ${observed.reason} · ${observed.candidates.map(format).join(' / ')}`,
      };
    case 'UNKNOWN':
      return { kind: 'unknown', text: `未知：${reasonLabel(observed.reason)}`, title: `UNKNOWN · ${observed.reason}` };
    case 'UNSUPPORTED':
      return { kind: 'unknown', text: `不支援：${reasonLabel(observed.reason)}`, title: `UNSUPPORTED · ${observed.reason}` };
  }
}

/**
 * The one value every window shares when none of them is KNOWN and all say
 * the same thing (for example, every volume window is UNKNOWN for the same
 * reason): it is then stated once instead of four times. Null otherwise.
 */
export function sharedNotKnown<T>(values: readonly Observed<T>[]): Observed<T> | null {
  const [first] = values;
  if (first === undefined || first.state === 'KNOWN' || first.state === 'STALE' || first.state === 'CONFLICTING') return null;
  const same = values.every((value) => value.state === first.state && 'reason' in value && value.reason === first.reason);
  return same ? first : null;
}
