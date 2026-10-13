import type { HealthReport } from '@morrow/core';
import { useEffect, useState } from 'react';

export const REFRESH_MS = 10_000;

/** A report and when this page asked for it. */
export interface ReceivedReport {
  readonly report: HealthReport;
  /**
   * When the request for this report was sent. The server stamps the report
   * while answering, so after this; ages counted from here can be too large
   * but never too small, even when the answer took long (a slow database).
   */
  readonly requestedAt: Date;
}

export type HealthState =
  | { readonly kind: 'loading' }
  | ({ readonly kind: 'ready' } & ReceivedReport)
  /** The API did not answer. `last` is the most recent report we did get, if any. */
  | { readonly kind: 'unreachable'; readonly message: string; readonly last: ReceivedReport | null };

/** Polls the local API for the health report. */
export function useHealth(): HealthState {
  const [state, setState] = useState<HealthState>({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;

    async function load(): Promise<void> {
      const requestedAt = new Date();
      try {
        const response = await fetch('/api/health', { cache: 'no-store' });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const report = (await response.json()) as HealthReport;
        if (!cancelled) setState({ kind: 'ready', report, requestedAt });
      } catch (error) {
        if (cancelled) return;
        const message = error instanceof Error ? error.message : String(error);
        setState((previous) => ({
          kind: 'unreachable',
          message,
          last:
            previous.kind === 'ready'
              ? { report: previous.report, requestedAt: previous.requestedAt }
              : previous.kind === 'unreachable'
                ? previous.last
                : null,
        }));
      }
    }

    void load();
    const timer = window.setInterval(() => void load(), REFRESH_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  return state;
}

/** The current time, updated every `intervalMs`, so relative times keep counting between polls. */
export function useNow(intervalMs = 1_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
}
