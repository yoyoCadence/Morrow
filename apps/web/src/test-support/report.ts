import { HealthReport, type QuotaView, type SessionView, type SourceHealthView } from '@morrow/core';

/** The server time stamped on every fixture report. */
export const REPORT_TIME = '2026-10-14T03:00:00.000Z';
export const REPORT_MS = Date.parse(REPORT_TIME);

/**
 * A health report with nothing wrong and nothing in it, changed by
 * `overrides`. Parsed with the shared schema, so a fixture the API could not
 * send fails here instead of testing a case that cannot happen.
 */
export function healthReport(overrides: Partial<HealthReport> = {}): HealthReport {
  return HealthReport.parse({
    status: 'ok',
    findings: [],
    time: REPORT_TIME,
    version: 'test',
    mode: 'RESEARCH',
    live_trading_enabled: false,
    database: { reachable: true, migrations_applied: 5, migrations_pending: 0, problem: null },
    sessions: [],
    recent_gaps: [],
    sources: [],
    quota: [],
    jobs: { queued: 0, leased: 0, dead: 0 },
    recent_event_conflicts: 0,
    clock: { skew_ms: null, samples: 0 },
    ...overrides,
  });
}

export function source(
  provider: string,
  capability: string,
  state: SourceHealthView['state'],
  overrides: Partial<SourceHealthView> = {},
): SourceHealthView {
  const healthy = state === 'HEALTHY';
  return {
    provider,
    capability,
    state,
    last_outcome: healthy ? 'OK' : 'SERVER_ERROR',
    last_http_status: null,
    consecutive_failures: healthy ? 0 : 1,
    blocked_until: null,
    last_success_at: null,
    last_failure_at: null,
    last_error_class: null,
    quota_bucket: null,
    updated_at: REPORT_TIME,
    ...overrides,
  };
}

/** A bucket with the OKX limits: warning at 70,000, hard stop at 85,000, provider limit 100,000. */
export function quotaBucket(provider: string, bucket: string, used: number, overrides: Partial<QuotaView> = {}): QuotaView {
  return {
    provider,
    bucket,
    period_start: '2026-10-01',
    used,
    warn_at: 70_000,
    hard_stop_at: 85_000,
    source_limit: 100_000,
    state: used >= 85_000 ? 'HARD_STOP' : used >= 70_000 ? 'WARN' : 'OK',
    ...overrides,
  };
}

export function workerSession(liveness: SessionView['liveness'], lastHeartbeatAt = REPORT_TIME): SessionView {
  const ended = liveness === 'ENDED';
  return {
    id: '1',
    component: 'worker',
    mode: 'RESEARCH',
    status: ended ? 'STOPPED' : 'RUNNING',
    liveness,
    started_at: '2026-10-14T00:00:00.000Z',
    last_heartbeat_at: lastHeartbeatAt,
    ended_at: ended ? lastHeartbeatAt : null,
  };
}
