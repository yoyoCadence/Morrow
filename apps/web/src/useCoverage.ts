import type { CoverageReport } from '@morrow/core';
import { useEffect, useState } from 'react';

/** Coverage changes slowly; once a minute is enough. */
const COVERAGE_REFRESH_MS = 60_000;

export type CoverageState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly day: CoverageReport; readonly week: CoverageReport }
  | { readonly kind: 'unavailable'; readonly message: string };

async function fetchCoverage(hours: number): Promise<CoverageReport> {
  const response = await fetch(`/api/coverage?hours=${hours}`, { cache: 'no-store' });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return (await response.json()) as CoverageReport;
}

/** Polls the worker's observation coverage for the last day and the last week. */
export function useCoverage(): CoverageState {
  const [state, setState] = useState<CoverageState>({ kind: 'loading' });
  useEffect(() => {
    let cancelled = false;
    async function load(): Promise<void> {
      try {
        const [day, week] = await Promise.all([fetchCoverage(24), fetchCoverage(168)]);
        if (!cancelled) setState({ kind: 'ready', day, week });
      } catch (error) {
        if (!cancelled) setState({ kind: 'unavailable', message: error instanceof Error ? error.message : String(error) });
      }
    }
    void load();
    const timer = window.setInterval(() => void load(), COVERAGE_REFRESH_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);
  return state;
}
