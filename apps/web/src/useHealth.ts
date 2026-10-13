import { HealthReport } from '@morrow/core';
import { useEffect, useState } from 'react';
import { FetchError, fetchChecked, startPolling, type FetchProblem } from './poll.js';

export const REFRESH_MS = 10_000;
/** In a background tab: slower, but the tab title and icon keep reporting the state. */
const HIDDEN_REFRESH_MS = 60_000;
/** Longer than a healthy answer takes, shorter than the database's own statement timeout. */
const TIMEOUT_MS = 15_000;

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
  /**
   * No usable answer: none in time, no connection, an HTTP error, or an
   * answer that does not match the contract. `last` is the most recent
   * report we did get, if any.
   */
  | {
      readonly kind: 'unreachable';
      readonly problem: FetchProblem;
      readonly message: string;
      readonly last: ReceivedReport | null;
    };

/**
 * Polls the local API for the health report: never two requests at once,
 * each given up after TIMEOUT_MS, every answer checked against the
 * `HealthReport` schema, slower while the tab is in the background.
 */
export function useHealth(): HealthState {
  const [state, setState] = useState<HealthState>({ kind: 'loading' });

  useEffect(() => {
    const controller = new AbortController();
    const stop = startPolling(
      async () => {
        const requestedAt = new Date();
        try {
          const report = await fetchChecked('/api/health', HealthReport, TIMEOUT_MS, controller.signal);
          setState({ kind: 'ready', report, requestedAt });
        } catch (error) {
          if (controller.signal.aborted) return;
          const problem: FetchProblem = error instanceof FetchError ? error.problem : 'network';
          const message = error instanceof Error ? error.message : String(error);
          setState((previous) => ({
            kind: 'unreachable',
            problem,
            message,
            last:
              previous.kind === 'ready'
                ? { report: previous.report, requestedAt: previous.requestedAt }
                : previous.kind === 'unreachable'
                  ? previous.last
                  : null,
          }));
        }
      },
      { visibleMs: REFRESH_MS, hiddenMs: HIDDEN_REFRESH_MS },
    );
    return () => {
      controller.abort();
      stop();
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
