import { CoverageReport } from '@morrow/core';
import { useEffect, useState } from 'react';
import { fetchChecked, startPolling } from './poll';

/** Coverage changes slowly; once a minute is enough, and every five while the tab is hidden. */
const COVERAGE_REFRESH_MS = 60_000;
const HIDDEN_COVERAGE_REFRESH_MS = 300_000;
const TIMEOUT_MS = 15_000;

export type CoverageState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly day: CoverageReport; readonly week: CoverageReport }
  | { readonly kind: 'unavailable'; readonly message: string };

/** Polls the worker's observation coverage for the last day and the last week, the same way as health. */
export function useCoverage(): CoverageState {
  const [state, setState] = useState<CoverageState>({ kind: 'loading' });
  useEffect(() => {
    const controller = new AbortController();
    const fetchCoverage = (hours: number) =>
      fetchChecked(`/api/coverage?hours=${hours}`, CoverageReport, TIMEOUT_MS, controller.signal);
    const stop = startPolling(
      async () => {
        try {
          const [day, week] = await Promise.all([fetchCoverage(24), fetchCoverage(168)]);
          setState({ kind: 'ready', day, week });
        } catch (error) {
          if (!controller.signal.aborted) {
            setState({ kind: 'unavailable', message: error instanceof Error ? error.message : String(error) });
          }
        }
      },
      { visibleMs: COVERAGE_REFRESH_MS, hiddenMs: HIDDEN_COVERAGE_REFRESH_MS },
    );
    return () => {
      controller.abort();
      stop();
    };
  }, []);

  return state;
}
