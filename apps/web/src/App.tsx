import type { CoverageReport, HealthReport } from '@morrow/core';
import { useEffect, useId, useState } from 'react';
import { COVERAGE_REASON_LABELS, coverageKind, coveragePercent, formatSpan, gapTotals } from './coverage.js';
import { describeProjection, projectHardStop } from './quota.js';
import { bucketUsage, groupSources, groupSummary, sourceTone } from './sources.js';
import { faviconPath, indicators, LEVELS, pageTitle, type PageState, type Tone } from './status.js';
import { formatRelative, formatTime, freshness, serverNow, type Freshness } from './time.js';
import { Ago, Badge, Section } from './ui.js';
import { EvidencePage, Link, ObservationPage } from './Evidence.js';
import { MarketPage } from './Market.js';
import { useRoute } from './route.js';
import { useCoverage } from './useCoverage.js';
import { REFRESH_MS, useHealth, useNow, type HealthState } from './useHealth.js';

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

const taipeiShort = new Intl.DateTimeFormat('zh-TW', {
  timeZone: 'Asia/Taipei',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

/** A gap is drawn at least this wide (of 1000 units, so 0.3%): a short crash in a week must stay visible. */
const MIN_GAP_UNITS = 3;

/**
 * One window as a strip: observing, gaps nobody chose, stopped on purpose,
 * and no record, each segment with its times as a tooltip. Every segment is
 * drawn at its true width first; gaps narrower than MIN_GAP_UNITS are then
 * drawn again on top at that width, kept inside the strip, so a neighbour
 * painted later cannot cover them.
 */
function CoverageBand({ title, report }: { title: string; report: CoverageReport }) {
  // Unexpected gaps also carry stripes, so they differ from observing time by more than red against green.
  const hatchId = useId();
  const from = Date.parse(report.from);
  const span = Math.max(report.window_ms, 1);
  const gaps = gapTotals(report);
  const percent = coveragePercent(report);
  const placed = report.segments.map((segment) => {
    const start = Date.parse(segment.start);
    const end = Date.parse(segment.end);
    return {
      segment,
      x: ((start - from) / span) * 1000,
      width: ((end - start) / span) * 1000,
      label: `${taipeiShort.format(start)} – ${taipeiShort.format(end)}：${
        segment.reason === null ? '觀測中' : COVERAGE_REASON_LABELS[segment.reason]
      }`,
    };
  });
  const rect = (key: string, item: (typeof placed)[number], x: number, width: number) => {
    const kind = coverageKind(item.segment.reason);
    return (
      // The title sits on the group, so either rectangle under the pointer shows this segment's tooltip.
      <g key={key}>
        <title>{item.label}</title>
        <rect className={`cov-${kind}`} x={x} y={0} width={width} height={14} />
        {kind === 'abnormal' ? <rect className="cov-hatch" x={x} y={0} width={width} height={14} fill={`url(#${hatchId})`} /> : null}
      </g>
    );
  };
  return (
    <div className="coverage">
      <p className="coverage-head">
        <strong>{title}</strong>
        <span>觀測 {percent}</span>
        <span className="coverage-gaps">
          {gaps.length === 0
            ? '全程觀測'
            : `未觀測：${gaps.map((gap) => `${COVERAGE_REASON_LABELS[gap.reason]} ${formatSpan(gap.ms)}`).join('、')}`}
        </span>
      </p>
      <svg className="coverage-band" viewBox="0 0 1000 14" preserveAspectRatio="none" role="img" aria-label={`${title}觀測 ${percent}`}>
        <title>{`${title}觀測 ${percent}`}</title>
        <defs>
          <pattern id={hatchId} patternUnits="userSpaceOnUse" width="8" height="14" patternTransform="skewX(-35)">
            <rect className="cov-hatch-line" x="0" y="0" width="3" height="14" />
          </pattern>
        </defs>
        {placed.map((item) => rect(item.segment.start, item, item.x, item.width))}
        {placed
          .filter((item) => !item.segment.observing && item.width < MIN_GAP_UNITS)
          .map((item) => rect(`${item.segment.start}:min`, item, Math.min(item.x, 1000 - MIN_GAP_UNITS), MIN_GAP_UNITS))}
      </svg>
      <div className="coverage-axis">
        <span>{taipeiShort.format(from)}</span>
        <span>現在</span>
      </div>
    </div>
  );
}

/** When the worker was observing over the last day and week. Polled on its own, once a minute. */
function CoverageSection() {
  const coverage = useCoverage();
  return (
    <Section
      title="觀測覆蓋"
      hint="worker 在 RESEARCH 或 PAPER 模式下、有心跳的時間。沒有觀測的時段沒有資料，不代表沒有事件發生。"
    >
      {coverage.kind === 'loading' ? (
        <p className="empty">讀取中…</p>
      ) : coverage.kind === 'unavailable' ? (
        <p className="problem">無法取得覆蓋資料（{coverage.message}）。</p>
      ) : (
        <>
          <CoverageBand title="近 24 小時" report={coverage.day} />
          <CoverageBand title="近 7 天" report={coverage.week} />
          <ul className="coverage-legend">
            <li>
              <span className="swatch cov-observing" aria-hidden="true" />
              觀測中
            </li>
            <li>
              <span className="swatch cov-abnormal" aria-hidden="true" />
              非預期中斷（異常中止、休眠或凍結、心跳中斷）
            </li>
            <li>
              <span className="swatch cov-stopped" aria-hidden="true" />
              停止或 OFF 模式
            </li>
            <li>
              <span className="swatch cov-unknown" aria-hidden="true" />
              沒有紀錄
            </li>
          </ul>
        </>
      )}
    </Section>
  );
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
            <table className="sources responsive">
              <caption className="visually-hidden">各資料來源功能最近一次請求的結果，依供應商分組</caption>
              <thead>
                <tr>
                  <th scope="col">功能</th>
                  <th scope="col">狀態</th>
                  <th scope="col">最近結果</th>
                  <th scope="col">額度桶</th>
                  <th scope="col">暫停到</th>
                  <th scope="col">最近成功</th>
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
                      <td className="cell-primary" data-label="功能">
                        {source.capability === '*' ? '全部功能（共用的 rate limit）' : source.capability}
                      </td>
                      <td className="cell-status" data-label="狀態">
                        <Badge tone={sourceTone(source.state)}>{source.state}</Badge>
                      </td>
                      <td className="result" data-label="最近結果">
                        {lastResult(source)}
                      </td>
                      <td
                        className={source.quota_bucket === null ? 'is-empty' : undefined}
                        data-label="額度桶"
                        title={source.quota_bucket === null ? '沒有月額度' : undefined}
                      >
                        {bucketUsage(source, report.quota)}
                      </td>
                      <td className={stillBlocked(source.blocked_until, now) ? undefined : 'is-empty'} data-label="暫停到">
                        <Ago iso={stillBlocked(source.blocked_until, now) ? source.blocked_until : null} now={now} />
                      </td>
                      <td data-label="最近成功">
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
          <table className="responsive">
            <caption className="visually-hidden">各元件最近一次的執行階段</caption>
            <thead>
              <tr>
                <th scope="col">元件</th>
                <th scope="col">狀態</th>
                <th scope="col">模式</th>
                <th scope="col">啟動</th>
                <th scope="col">最後心跳</th>
              </tr>
            </thead>
            <tbody>
              {report.sessions.map((session) => (
                <tr key={session.id}>
                  <td className="cell-primary" data-label="元件">
                    {session.component}
                  </td>
                  <td className="cell-status" data-label="狀態">
                    <SessionBadge session={session} />
                  </td>
                  <td data-label="模式">{session.mode}</td>
                  <td data-label="啟動">
                    <Ago iso={session.started_at} now={now} />
                  </td>
                  <td data-label="最後心跳">
                    <Ago iso={session.last_heartbeat_at} now={now} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>

      <CoverageSection />

      <Section title="觀測缺口" hint="這些時段系統沒有在觀測。缺口內沒有資料，不代表沒有事件發生。">
        {report.recent_gaps.length === 0 ? (
          <p className="empty">沒有紀錄到缺口。</p>
        ) : (
          <table className="responsive">
            <caption className="visually-hidden">最近記錄到的觀測缺口</caption>
            <thead>
              <tr>
                <th scope="col">元件</th>
                <th scope="col">原因</th>
                <th scope="col">開始</th>
                <th scope="col">結束</th>
                <th scope="col">長度</th>
              </tr>
            </thead>
            <tbody>
              {report.recent_gaps.map((gap) => (
                <tr key={`${gap.component}-${gap.gap_start}-${gap.kind}`}>
                  <td className="cell-primary" data-label="元件">
                    {gap.component}
                  </td>
                  <td className="cell-status" data-label="原因">
                    {GAP_LABELS[gap.kind]}
                  </td>
                  <td data-label="開始">{formatTime(gap.gap_start)}</td>
                  <td data-label="結束">{formatTime(gap.gap_end)}</td>
                  <td data-label="長度">{formatDuration(gap.gap_start, gap.gap_end)}</td>
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
        <table className="quota responsive">
          <caption className="visually-hidden">各額度桶本月的用量、門檻與推估</caption>
          <thead>
            <tr>
              <th scope="col">供應商</th>
              <th scope="col">額度桶</th>
              <th scope="col">用量</th>
              <th scope="col">警告線</th>
              <th scope="col">硬性上限</th>
              <th scope="col">供應商上限</th>
              <th scope="col">依目前速度</th>
              <th scope="col">狀態</th>
            </tr>
          </thead>
          <tbody>
            {report.quota.map((bucket) => (
              <tr key={`${bucket.provider}/${bucket.bucket}`}>
                <td className="cell-primary" data-label="供應商">
                  {bucket.provider}
                  <span className="narrow-only" aria-hidden="true">
                    {' '}
                    / {bucket.bucket}
                  </span>
                </td>
                <td className="wide-only" data-label="額度桶">
                  {bucket.bucket}
                </td>
                <td data-label="用量">
                  <span className="quota-used">
                    <QuotaBar bucket={bucket} />
                    {wholeNumber.format(bucket.used)}
                  </span>
                </td>
                <td data-label="警告線">{wholeNumber.format(bucket.warn_at)}</td>
                <td data-label="硬性上限">{wholeNumber.format(bucket.hard_stop_at)}</td>
                <td data-label="供應商上限">{wholeNumber.format(bucket.source_limit)}</td>
                <td data-label="依目前速度">{describeProjection(projectHardStop(bucket, now))}</td>
                <td className="cell-status" data-label="狀態">
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
  useTabState(health.kind === 'ready' ? health.report.status : health.kind);
  const route = useRoute();
  // Ages are counted on the server's clock once a report has arrived, as on the system page.
  const clock = received ? serverNow(received.report.time, received.requestedAt.getTime(), now) : now;

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
        <nav className="pages" aria-label="頁面">
          <Link to={{ page: 'system' }} current={route.page === 'system'}>
            系統
          </Link>
          <Link to={{ page: 'market' }} current={route.page === 'market'}>
            市場
          </Link>
          <Link to={{ page: 'evidence', subject: null }} current={route.page === 'evidence' || route.page === 'observation'}>
            證據
          </Link>
        </nav>
      </header>

      {route.page === 'market' ? <MarketPage now={clock} /> : null}
      {route.page === 'evidence' ? <EvidencePage subject={route.subject} now={clock} /> : null}
      {route.page === 'observation' ? <ObservationPage id={route.id} /> : null}
      {route.page === 'system' ? <SystemPage health={health} clock={clock} /> : null}
    </main>
  );
}

/** Health, sources, quota and coverage: what the dashboard showed before it had pages. */
function SystemPage({ health, clock }: { health: HealthState; clock: number }) {
  const received = health.kind === 'ready' ? health : health.kind === 'unreachable' ? health.last : null;
  const report = received?.report ?? null;
  return (
    <>
      {health.kind === 'loading' ? <p className="empty">讀取中…</p> : null}
      {health.kind === 'unreachable' ? (
        <p className="alert" role="alert">
          {health.problem === 'contract'
            ? `儀表板與 API 不是同一個版本（${health.message}）。重新建置（npm run build）並重新啟動 API，再重新整理這個頁面。`
            : `無法取得本機 API 的狀態（${health.message}）。`}
          {report ? '以下是最後一次取得的狀態，可能已過期。' : health.problem === 'contract' ? '' : '請確認 API 已啟動：npm run api'}
        </p>
      ) : null}
      {received ? (
        // Dimmed while the API is unreachable: it is the last known state, not the current one.
        <div className={health.kind === 'unreachable' ? 'report report-stale' : 'report'}>
          <Report report={received.report} now={clock} />
        </div>
      ) : null}
    </>
  );
}
