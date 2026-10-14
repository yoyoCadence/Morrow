import { useCallback, useEffect, useRef, useState } from 'react';
import { FetchError, type FetchProblem, fetchChecked, type PollingOptions, type Schema, startPolling } from './poll.js';

/** Longer than a healthy answer takes, shorter than the database's own statement timeout. */
const TIMEOUT_MS = 15_000;

export type Resource<T> =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly data: T }
  /** For an HTTP error the message is "HTTP <status>", for example "HTTP 404". */
  | { readonly kind: 'error'; readonly problem: FetchProblem; readonly message: string };

function failure(error: unknown): Extract<Resource<never>, { kind: 'error' }> {
  return {
    kind: 'error',
    problem: error instanceof FetchError ? error.problem : 'network',
    message: error instanceof Error ? error.message : String(error),
  };
}

/**
 * Fetches `url` once, checked against `schema`, and again whenever `url`
 * changes. Evidence does not change after it is stored, so there is no
 * polling. A request still running when the page moves on is cancelled.
 */
export function useResource<T>(url: string, schema: Schema<T>): Resource<T> {
  const [state, setState] = useState<Resource<T>>({ kind: 'loading' });
  useEffect(() => {
    const controller = new AbortController();
    setState({ kind: 'loading' });
    fetchChecked(url, schema, TIMEOUT_MS, controller.signal).then(
      (data) => setState({ kind: 'ready', data }),
      (error: unknown) => {
        if (!controller.signal.aborted) setState(failure(error));
      },
    );
    return () => controller.abort();
  }, [url, schema]);
  return state;
}

export interface PagedList<T> {
  readonly items: readonly T[];
  readonly state: 'loading' | 'ready' | 'more' | 'error';
  /** Set when the last request failed. */
  readonly error: string | null;
  /** True while an older page exists. */
  readonly hasMore: boolean;
  /** Reads the next page; after a failure, the page that failed (the first one if that is what failed). */
  readonly loadMore: () => void;
}

/**
 * A newest-first list read a page at a time: `baseUrl` gives the first page,
 * and `loadMore` appends the next one through its `next_before` cursor.
 * Starts over when `baseUrl` changes.
 */
export function usePagedList<Page, T>(
  baseUrl: string,
  schema: Schema<Page>,
  pick: (page: Page) => { items: readonly T[]; next: string | null },
): PagedList<T> {
  const [items, setItems] = useState<readonly T[]>([]);
  const [state, setState] = useState<PagedList<T>['state']>('loading');
  const [error, setError] = useState<string | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const controller = useRef<AbortController | null>(null);
  const pickRef = useRef(pick);
  pickRef.current = pick;

  const load = useCallback(
    (cursor: string | null) => {
      controller.current?.abort();
      const current = new AbortController();
      controller.current = current;
      setState(cursor === null ? 'loading' : 'more');
      const separator = baseUrl.includes('?') ? '&' : '?';
      const url = cursor === null ? baseUrl : `${baseUrl}${separator}before=${cursor}`;
      fetchChecked(url, schema, TIMEOUT_MS, current.signal).then(
        (page) => {
          const picked = pickRef.current(page);
          setItems((previous) => (cursor === null ? picked.items : [...previous, ...picked.items]));
          setNext(picked.next);
          setError(null);
          setState('ready');
        },
        (failed: unknown) => {
          if (current.signal.aborted) return;
          setError(failure(failed).message);
          setState('error');
        },
      );
    },
    [baseUrl, schema],
  );

  useEffect(() => {
    setItems([]);
    setNext(null);
    load(null);
    return () => controller.current?.abort();
  }, [load]);

  return { items, state, error, hasMore: next !== null, loadMore: () => load(next) };
}

export interface Polled<T> {
  /** The last answer received; kept through a refresh that fails. Null until the first one arrives. */
  readonly data: T | null;
  /** Why the latest request failed; null once one succeeds. */
  readonly error: string | null;
}

/**
 * Fetches `url` now and again on the polling schedule, for data that keeps
 * arriving. A failed refresh keeps the last answer and reports the failure
 * next to it, so the page shows how old its data is instead of going blank.
 */
export function usePolled<T>(url: string, schema: Schema<T>, options: PollingOptions): Polled<T> {
  const [state, setState] = useState<Polled<T>>({ data: null, error: null });
  const { visibleMs, hiddenMs } = options;
  useEffect(() => {
    const controller = new AbortController();
    setState({ data: null, error: null });
    const stop = startPolling(
      async () => {
        try {
          const data = await fetchChecked(url, schema, TIMEOUT_MS, controller.signal);
          setState({ data, error: null });
        } catch (error) {
          if (!controller.signal.aborted) setState((previous) => ({ data: previous.data, error: failure(error).message }));
        }
      },
      { visibleMs, hiddenMs },
    );
    return () => {
      controller.abort();
      stop();
    };
  }, [url, schema, visibleMs, hiddenMs]);
  return state;
}
