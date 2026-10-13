/** Why a request did not give a usable answer. */
export type FetchProblem = 'timeout' | 'network' | 'http' | 'contract';

export class FetchError extends Error {
  constructor(
    readonly problem: FetchProblem,
    message: string,
  ) {
    super(message);
    this.name = 'FetchError';
  }
}

/** The part of a zod schema this needs, so the dashboard checks answers against the shared contract. */
export interface Schema<T> {
  safeParse(data: unknown): { success: true; data: T } | { success: false; error: { issues: ReadonlyArray<{ path: PropertyKey[]; message: string }> } };
}

/**
 * GETs `url` and returns the answer only if it matches `schema`. Gives up
 * after `timeoutMs`, and at once when `signal` aborts. An answer that does
 * not match the contract is an error, not something to render: it means the
 * API and this page come from different builds.
 */
export async function fetchChecked<T>(url: string, schema: Schema<T>, timeoutMs: number, signal: AbortSignal): Promise<T> {
  const timeout = AbortSignal.timeout(timeoutMs);
  let response: Response;
  try {
    response = await fetch(url, { cache: 'no-store', signal: AbortSignal.any([signal, timeout]) });
  } catch (error) {
    if (timeout.aborted) throw new FetchError('timeout', `${timeoutMs / 1000} 秒內沒有回應`);
    throw new FetchError('network', error instanceof Error ? error.message : String(error));
  }
  if (!response.ok) throw new FetchError('http', `HTTP ${response.status}`);
  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    // The body can still be arriving when the deadline passes or the page goes
    // away; that is a timeout or a cancellation, not a body in the wrong shape.
    if (timeout.aborted) throw new FetchError('timeout', `${timeoutMs / 1000} 秒內沒有收完回應`);
    if (signal.aborted) throw new FetchError('network', error instanceof Error ? error.message : String(error));
    throw new FetchError('contract', '回應不是 JSON');
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue && issue.path.length > 0 ? issue.path.map(String).join('.') : '（整個回應）';
    throw new FetchError('contract', `回應不符合契約：${where} ${issue?.message ?? ''}`.trim());
  }
  return parsed.data;
}

export interface PollingOptions {
  /** Pause between the end of one run and the start of the next while the page is visible. */
  readonly visibleMs: number;
  /** The same while the page is hidden. Slower, not stopped: the tab title and icon still report the state. */
  readonly hiddenMs: number;
}

/**
 * Runs `task` now, then again a pause after each run finishes, so runs never
 * overlap however long one takes. Runs again at once when the page becomes
 * visible. Returns a function that stops it.
 */
export function startPolling(task: () => Promise<void>, options: PollingOptions): () => void {
  let stopped = false;
  let running = false;
  let timer: number | undefined;
  const schedule = (): void => {
    if (stopped) return;
    window.clearTimeout(timer);
    timer = window.setTimeout(run, document.hidden ? options.hiddenMs : options.visibleMs);
  };
  async function run(): Promise<void> {
    if (stopped || running) return;
    running = true;
    try {
      await task();
    } finally {
      running = false;
      schedule();
    }
  }
  const onVisibilityChange = (): void => {
    // A run in flight reschedules itself when it ends, at the visible pace.
    if (!document.hidden && !running) {
      window.clearTimeout(timer);
      void run();
    }
  };
  document.addEventListener('visibilitychange', onVisibilityChange);
  void run();
  return () => {
    stopped = true;
    window.clearTimeout(timer);
    document.removeEventListener('visibilitychange', onVisibilityChange);
  };
}
