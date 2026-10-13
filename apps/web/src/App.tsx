import type { HealthReport } from '@morrow/core';
import { useEffect, useState, type ReactNode } from 'react';
import { describeProjection, projectHardStop } from './quota';
import { bucketUsage, groupSources, groupSummary, sourceTone } from './sources';
import { faviconPath, indicators, LEVELS, pageTitle, type PageState, type Tone } from './status';
import { formatRelative, formatTime, freshness, serverNow, type Freshness } from './time';
import { REFRESH_MS, useHealth, useNow, type HealthState } from './useHealth';

const wholeNumber = new Intl.NumberFormat('zh-TW');

function formatDuration(startIso: string, endIso: string): string {
  const seconds = Math.max(0, Math.round((Date.parse(endIso) - Date.parse(startIso)) / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} 分鐘`;
  return `${(seconds / 3600).toFixed(1)} 小時`;
}

const GAP_LABELS: Record<HealthReport['recent_gaps'][number]['kind'], string> = {
  UNCLEAN_SHUTDOWN: '異常中止',
  OFFLINE: '離線',
  HEARTBEAT_STALL: '休眠或凍結',
};

function Badge({ tone, children }: { tone: Tone; children: ReactNode }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section className="card">
      <h2>{title}</h2>
      {hint ? <p className="hint">{hint}</p> : null}
      {children}
    </section>
  );
}

/** A relative time such as "12 秒前", with the full Taipei time as its tooltip. */
function Ago({ iso, now }: { iso: string | null; now: number }) {
  if (iso === null) return <>—</>;
  return (
    <time dateTime={iso} title={`${formatTime(iso)}（台北）`}>
      {formatRelative(Date.parse(iso), now)}
    </time>
  );
}

/** RUNNING is only shown as healthy while the session still heartbeats. */
function SessionBadge({ session }: { session: HealthReport['sessions'][number] }) {
  if (session.liveness === 'STALE') return <Badge tone="bad">心跳中斷</Badge>;
  if (session.status === 'RUNNING') return <Badge tone="good">RUNNING</Badge>;
  return <Badge tone={session.status === 'STOPPED' ? 'neutral' : 'bad'}>{session.status}</Badge>;
}

/** A backoff that has already ended is no longer worth showing. */
function stillBlocked(blockedUntil: string | null, now: number): boolean {
  return blockedUntil !== null && Date.parse(blockedUntil) > now;
}

const QUOTA_TONE: Record<HealthReport['quota'][number]['state'], Tone> = { OK: 'good', WARN: 'warn', HARD_STOP: 'bad' };

/**
 * Use so far against the provider's own limit (the full width), with the
 * warning line and the local hard stop marked. Drawn in SVG, so it needs no
 * inline styles under the API's content security policy.
 */
function QuotaBar({ bucket }: { bucket: HealthReport['quota'][number] }) {
  const scale = Math.max(bucket.source_limit, bucket.hard_stop_at, bucket.used, 1);
  const at = (value: number): number => Math.min(100, (value / scale) * 100);
  const label =
    `已用 ${wholeNumber.format(bucket.used)}，警告線 ${wholeNumber.format(bucket.warn_at)}，` +
    `硬性上限 ${wholeNumber.format(bucket.hard_stop_at)}，供應商上限 ${wholeNumber.format(bucket.source_limit)}`;
  return (
    <svg className={`quota-bar quota-${QUOTA_TONE[bucket.state]}`} viewBox="0 0 100 12" preserveAspectRatio="none" role="img" aria-label={label}>
      <title>{label}</title>
      <rect className="quota-track" x="0" y="3" width="100" height="6" />
      <rect className="quota-fill" x="0" y="3" width={at(bucket.used)} height="6" />
      <line className="quota-mark-warn" x1={at(bucket.warn_at)} x2={at(bucket.warn_at)} y1="0" y2="12" vectorEffect="non-scaling-stroke" />
      <line className="quota-mark-hard" x1={at(bucket.hard_stop_at)} x2={at(bucket.hard_stop_at)} y1="0" y2="12" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

// The "only issues" choice is a per-browser convenience; without storage it simply starts unticked.
const ONLY_ISSUES_KEY = 'morrow.sources.onlyIssues';

function readOnlyIssues(): boolean {
  try {
    return window.localStorage.getItem(ONLY_ISSUES_KEY) === '1';
  } catch {
    return false;
  }
}

function writeOnlyIssues(value: boolean): void {
  try {
    window.localStorage.setItem(ONLY_ISSUES_KEY, value ? '1' : '0');
  } catch {
    // Storage blocked: the choice lasts until the page is closed.
  }
}

function lastResult(source: HealthReport['sources'][number]): string {
  const details = [source.last_http_status !== null ? `HTTP ${source.last_http_status}` : null, source.last_error_class].filter(Boolean);
  return details.length > 0 ? `${source.last_outcome}（${details.join(' · ')}）` : source.last_outcome;
}

/**
 * Sources grouped by provider, the provider with the worst problem first and
 * problems first within it, with an "only issues" filter. The quota bucket
 * column shows which monthly allowance a capability spends and how much of
 * it is used.
 */
function SourcesSection({ report, now }: { report: HealthReport; now: number }) {
  const [onlyIssues, setOnlyIssues] = useState(readOnlyIssues);
  const groups = groupSources(report.sources, onlyIssues);
  // The provider-wide row (`*`) is not a capability, so it is not counted among the hidden ones.
  const hidden = onlyIssues
    ? report.sources.filter((source) => source.state === 'HEALTHY' && source.capability !== '*').length
    : 0;
  return (
    <Section title="資料來源" hint="每個供應商功能最近一次請求的結果，有問題的排在最前面。">
      {report.sources.length === 0 ? (
        <p className="empty">尚未對任何來源發出請求。執行 npm run probe 可量測目前的額度與權限。</p>
      ) : (
        <>
          <label className="filter">
            <input
              type="checkbox"
              checked={onlyIssues}
              onChange={(event) => {
                setOnlyIssues(event.target.checked);
                writeOnlyIssues(event.target.checked);
              }}
            />
            只看異常{hidden > 0 ? `（已隱藏 ${hidden} 個正常的功能）` : ''}
          </label>
          {groups.length === 0 ? (
            <p className="empty">所有來源都正常。</p>
          ) : (
            <table className="sources">
              <thead>
                <tr>
                  <th>功能</th>
                  <th>狀態</th>
                  <th>最近結果</th>
                  <th>額度桶</th>
                  <th>暫停到</th>
                  <th>最近成功</th>
                </tr>
              </thead>
              {groups.map((group) => (
                <tbody key={group.provider}>
                  <tr className="group-row">
                    <th colSpan={6} scope="rowgroup">
                      <span className={`dot dot-${group.worst}`} aria-hidden="true" />
                      {group.provider}
                      <span className="group-summary">{groupSummary(group)}</span>
                    </th>
                  </tr>
                  {group.rows.map((source) => (
                    <tr key={`${source.provider}/${source.capability}`}>
                      <td>{source.capability === '*' ? '全部功能（共用的 rate limit）' : source.capability}</td>
                      <td>
                        <Badge tone={sourceTone(source.state)}>{source.state}</Badge>
                      </td>
                      <td className="result">{lastResult(source)}</td>
                      <td title={source.quota_bucket === null ? '沒有月額度' : undefined}>{bucketUsage(source, report.quota)}</td>
                      <td>
                        <Ago iso={stillBlocked(source.blocked_until, now) ? source.blocked_until : null} now={now} />
                      </td>
                      <td>
                        <Ago iso={source.last_success_at} now={now} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              ))}
            </table>
          )}
        </>
      )}
    </Section>
  );
}

const FINDING_LABELS: Record<HealthReport['findings'][number]['code'], string> = {
  DATABASE_UNREACHABLE: '無法連線到資料庫',
  MIGRATION_STATE_INVALID: '資料庫的 migration 狀態與程式不符',
  MIGRATIONS_PENDING: '有尚未套用的 migration',
  STATUS_QUERY_FAILED: '無法讀取系統狀態',
  SESSION_STALE: '程序心跳中斷',
  WORKER_NOT_RUNNING: '沒有在執行的 worker，這個模式需要它來觀測',
  SOURCE_DOWN: '資料來源無法使用',
  SOURCE_RATE_LIMITED: '資料來源限流中',
  SOURCE_UNAUTHORIZED: '憑證或地區被拒絕，需要人處理',
  SOURCE_PAYMENT_REQUIRED: '需要付費方案（系統不會付款）',
  SOURCE_REQUEST_REJECTED: '請求被供應商拒絕',
  SOURCE_CREDENTIAL_MISSING: '沒有設定憑證',
  QUOTA_WARN: '額度已過警告線',
  QUOTA_HARD_STOP: '額度已達硬性上限，請求停止',
  JOBS_DEAD: '有失敗終止的工作',
  EVENT_CONFLICTS: '同一個事實出現互相矛盾的內容',
  CLOCK_SKEW: '本機時鐘與供應商的時間不一致',
};

function formatSkew(clock: HealthReport['clock']): string {
  if (clock.skew_ms === null) return `未知（近期回應不足，${clock.samples} 個樣本）`;
  const seconds = clock.skew_ms / 1000;
  return `${seconds >= 0 ? '+' : ''}${seconds.toFixed(1)} 秒（${clock.samples} 個樣本）`;
}

function Findings({ findings }: { findings: HealthReport['findings'] }) {
  if (findings.length === 0) return null;
  return (
    <ul className="findings" aria-label="狀態原因">
      {findings.map((finding) => (
        // Unique: each code is reported at most once per subject.
        <li key={`${finding.code}:${finding.subject ?? ''}`}>
          <Badge tone={LEVELS[finding.severity].tone}>{LEVELS[finding.severity].label}</Badge>
          <span>{FINDING_LABELS[finding.code]}</span>
          {finding.subject ? <code>{finding.subject}</code> : null}
          <span className="detail">{finding.detail}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * The overall status, worst finding first, and four small facts: is the
 * worker heartbeating, how many sources are healthy, how close the fullest
 * quota is to its hard stop, and how many jobs failed for good. Each fact is
 * written out; the colour only repeats it.
 */
function StatusBar({ report, now }: { report: HealthReport; now: number }) {
  const level = LEVELS[report.status];
  const reasons = report.findings.length;
  return (
    <section className={`status-bar status-${level.tone}`} aria-label="整體狀態">
      <p className="status-level">
        <strong>{level.label}</strong>
        <span>{reasons === 0 ? '沒有需要處理的項目' : `${reasons} 個原因，見下方`}</span>
      </p>
      <ul className="indicators">
        {indicators(report, now).map((indicator) => (
          <li key={indicator.key} className={`indicator indicator-${indicator.tone}`}>
            <span className={`dot dot-${indicator.tone}`} aria-hidden="true" />
            {indicator.text}
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Keeps the tab title and favicon in step with the page, so the state shows from another tab. */
function useTabState(state: PageState): void {
  useEffect(() => {
    document.title = pageTitle(state);
    const icon = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (icon) icon.href = faviconPath(state);
  }, [state]);
}

/** `now` is the server's current time (see `serverNow`), so relative times do not depend on this browser's clock. */
function Report({ report, now }: { report: HealthReport; now: number }) {
  const { database } = report;
  return (
    <>
      <StatusBar report={report} now={now} />
      <div className="summary">
        <span>模式 {report.mode}</span>
        <span>版本 {report.version}</span>
        <span>伺服器時間 {formatTime(report.time)}（台北）</span>
        <span title="供應商回應的 Date header 減去本機收到的時間；正值表示本機時鐘較慢">時鐘偏移 {formatSkew(report.clock)}</span>
      </div>
      <Findings findings={report.findings} />

      <Section title="資料庫">
        <dl className="facts">
          <dt>連線</dt>
          <dd>{database.reachable ? <Badge tone="good">可連線</Badge> : <Badge tone="bad">無法連線</Badge>}</dd>
          <dt>Migrations</dt>
          <dd>
            已套用 {database.migrations_applied}
            {database.migrations_pending > 0 ? <Badge tone="warn">待套用 {database.migrations_pending}</Badge> : null}
          </dd>
          {database.problem ? (
            <>
              <dt>問題</dt>
              <dd className="problem">{database.problem}</dd>
            </>
          ) : null}
        </dl>
      </Section>

      <Section title="程序" hint="每個元件最近一次的執行階段。超過 30 秒沒有心跳的程序標為「心跳中斷」：它可能已當掉、被終止、凍結或休眠，這段期間沒有在觀測。">
        {report.sessions.length === 0 ? (
          <p className="empty">尚無執行紀錄。</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>元件</th>
                <th>狀態</th>
                <th>模式</th>
                <th>啟動</th>
                <th>最後心跳</th>
              </tr>
            </thead>
            <tbody>
              {report.sessions.map((session) => (
                <tr key={session.id}>
                  <td>{session.component}</td>
                  <td>
                    <SessionBadge session={session} />
                  </td>
                  <td>{session.mode}</td>
                  <td>
                    <Ago iso={session.started_at} now={now} />
                  </td>
                  <td>
                    <Ago iso={session.last_heartbeat_at} now={now} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>

      <Section title="觀測缺口" hint="這些時段系統沒有在觀測。缺口內沒有資料，不代表沒有事件發生。">
        {report.recent_gaps.length === 0 ? (
          <p className="empty">沒有紀錄到缺口。</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>元件</th>
                <th>原因</th>
                <th>開始</th>
                <th>結束</th>
                <th>長度</th>
              </tr>
            </thead>
            <tbody>
              {report.recent_gaps.map((gap) => (
                <tr key={`${gap.component}-${gap.gap_start}-${gap.kind}`}>
                  <td>{gap.component}</td>
                  <td>{GAP_LABELS[gap.kind]}</td>
                  <td>{formatTime(gap.gap_start)}</td>
                  <td>{formatTime(gap.gap_end)}</td>
                  <td>{formatDuration(gap.gap_start, gap.gap_end)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>

      <SourcesSection report={report} now={now} />

      <Section
        title="額度"
        hint="本月用量。條的全長是供應商上限；條上第一道刻度是警告線，第二道是硬性上限。到達硬性上限後系統自行停止請求，不付費、不換帳號。推估以本月到目前的平均速度計算，關機的時間也算在內。"
      >
        <table className="quota">
          <thead>
            <tr>
              <th>供應商</th>
              <th>額度桶</th>
              <th>用量</th>
              <th>警告線</th>
              <th>硬性上限</th>
              <th>供應商上限</th>
              <th>依目前速度</th>
              <th>狀態</th>
            </tr>
          </thead>
          <tbody>
            {report.quota.map((bucket) => (
              <tr key={`${bucket.provider}/${bucket.bucket}`}>
                <td>{bucket.provider}</td>
                <td>{bucket.bucket}</td>
                <td>
                  <span className="quota-used">
                    <QuotaBar bucket={bucket} />
                    {wholeNumber.format(bucket.used)}
                  </span>
                </td>
                <td>{wholeNumber.format(bucket.warn_at)}</td>
                <td>{wholeNumber.format(bucket.hard_stop_at)}</td>
                <td>{wholeNumber.format(bucket.source_limit)}</td>
                <td>{describeProjection(projectHardStop(bucket, now))}</td>
                <td>
                  <Badge tone={QUOTA_TONE[bucket.state]}>{bucket.state}</Badge>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>

      <Section title="工作佇列">
        <dl className="facts">
          <dt>等待中</dt>
          <dd>{report.jobs.queued}</dd>
          <dt>執行中</dt>
          <dd>{report.jobs.leased}</dd>
          <dt>失敗終止</dt>
          <dd>{report.jobs.dead > 0 ? <Badge tone="bad">{report.jobs.dead}</Badge> : 0}</dd>
        </dl>
      </Section>
    </>
  );
}

const FRESHNESS_TONE: Record<Freshness, Tone> = { fresh: 'good', late: 'warn', stale: 'bad' };

/** When this page last got a report, and whether it is still getting them. No animation: a steady dot. */
function UpdateIndicator({ health, now }: { health: HealthState; now: number }) {
  if (health.kind === 'loading') return null;
  const received = health.kind === 'ready' ? health : health.last;
  const requestedAt = received?.requestedAt.getTime() ?? now;
  // `now` ticks once a second, so a report that just arrived can be newer than it. An age is never negative.
  const age = Math.max(0, now - requestedAt);
  const tone: Tone = health.kind === 'unreachable' ? 'bad' : FRESHNESS_TONE[freshness(age, REFRESH_MS)];
  const ago = received ? formatRelative(requestedAt, requestedAt + age) : null;
  const text =
    health.kind === 'unreachable'
      ? ago === null
        ? '無法更新，尚未取得任何狀態'
        : `無法更新 · 上次成功 ${ago}`
      : `上次更新 ${ago}`;
  return (
    <p className="freshness" title={received ? `${formatTime(received.requestedAt.toISOString())}（台北）` : undefined}>
      <span className={`dot dot-${tone}`} aria-hidden="true" />
      {text}
    </p>
  );
}

export function App() {
  const health = useHealth();
  const now = useNow();
  const received = health.kind === 'ready' ? health : health.kind === 'unreachable' ? health.last : null;
  const report = received?.report ?? null;
  useTabState(health.kind === 'ready' ? health.report.status : health.kind);

  return (
    <main>
      <header>
        <div className="title-row">
          <h1>Morrow</h1>
          <UpdateIndicator health={health} now={now} />
        </div>
        <p className="paper-banner" role="note">
          僅限研究與 Paper 模式 · 實盤交易已停用（沒有簽署金鑰，所有實盤額度為 0）
        </p>
      </header>

      {health.kind === 'loading' ? <p className="empty">讀取中…</p> : null}
      {health.kind === 'unreachable' ? (
        <p className="alert" role="alert">
          無法連線到本機 API（{health.message}）。{report ? '以下是最後一次取得的狀態，可能已過期。' : '請確認 API 已啟動：npm run api'}
        </p>
      ) : null}
      {received ? (
        // Dimmed while the API is unreachable: it is the last known state, not the current one.
        <div className={health.kind === 'unreachable' ? 'report report-stale' : 'report'}>
          <Report report={received.report} now={serverNow(received.report.time, received.requestedAt.getTime(), now)} />
        </div>
      ) : null}
    </main>
  );
}
