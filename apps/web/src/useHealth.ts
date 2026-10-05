import type { HealthReport } from '@morrow/core';
import { useEffect, useState } from 'react';

const REFRESH_MS = 10_000;

export type HealthState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly report: HealthReport; readonly fetchedAt: Date }
  /** The API did not answer. `last` is the most recent report we did get, if any. */
  | { readonly kind: 'unreachable'; readonly message: string; readonly last: HealthReport | null };

/** Polls the local API for the health report. */
export function useHealth(): HealthState {
  const [state, setState] = useState<HealthState>({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;

    async function load(): Promise<void> {
      try {
        const response = await fetch('/api/health', { cache: 'no-store' });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const report = (await response.json()) as HealthReport;
        if (!cancelled) setState({ kind: 'ready', report, fetchedAt: new Date() });
      } catch (error) {
        if (cancelled) return;
        const message = error instanceof Error ? error.message : String(error);
        setState((previous) => ({
          kind: 'unreachable',
          message,
          last: previous.kind === 'ready' ? previous.report : previous.kind === 'unreachable' ? previous.last : null,
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
