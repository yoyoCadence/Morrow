import type { HealthReport } from '@morrow/core';
import type { ReactNode } from 'react';
import { useHealth } from './useHealth';

// Storage is UTC; the operator reads Asia/Taipei.
const taipeiTime = new Intl.DateTimeFormat('zh-TW', {
  timeZone: 'Asia/Taipei',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});
const wholeNumber = new Intl.NumberFormat('zh-TW');

function formatTime(iso: string | null): string {
  return iso === null ? '—' : taipeiTime.format(new Date(iso));
}

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

function Badge({ tone, children }: { tone: 'good' | 'warn' | 'bad' | 'neutral'; children: ReactNode }) {
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

/** A backoff that has already ended is no longer worth showing. */
function stillBlocked(blockedUntil: string | null, now: string): boolean {
  return blockedUntil !== null && Date.parse(blockedUntil) > Date.parse(now);
}

function sourceTone(state: HealthReport['sources'][number]['state']): 'good' | 'warn' | 'bad' {
  if (state === 'HEALTHY') return 'good';
  return state === 'RATE_LIMITED' || state === 'CREDENTIAL_MISSING' ? 'warn' : 'bad';
}

function Report({ report }: { report: HealthReport }) {
  const { database } = report;
  return (
    <>
      <div className="summary">
        <Badge tone={report.status === 'ok' ? 'good' : 'warn'}>{report.status === 'ok' ? '運作正常' : '部分異常'}</Badge>
        <span>模式 {report.mode}</span>
        <span>版本 {report.version}</span>
        <span>伺服器時間 {formatTime(report.time)}（台北）</span>
      </div>

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

      <Section title="程序" hint="每個元件最近一次的執行階段。">
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
                    <Badge tone={session.status === 'RUNNING' ? 'good' : session.status === 'STOPPED' ? 'neutral' : 'bad'}>
                      {session.status}
                    </Badge>
                  </td>
                  <td>{session.mode}</td>
                  <td>{formatTime(session.started_at)}</td>
                  <td>{formatTime(session.last_heartbeat_at)}</td>
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

      <Section title="資料來源" hint="每個供應商功能最近一次請求的結果。">
        {report.sources.length === 0 ? (
          <p className="empty">尚未對任何來源發出請求。執行 npm run probe 可量測目前的額度與權限。</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>供應商</th>
                <th>功能</th>
                <th>狀態</th>
                <th>最近結果</th>
                <th>暫停至</th>
                <th>最近成功</th>
              </tr>
            </thead>
            <tbody>
              {report.sources.map((source) => (
                <tr key={`${source.provider}/${source.capability}`}>
                  <td>{source.provider}</td>
                  <td>{source.capability}</td>
                  <td>
                    <Badge tone={sourceTone(source.state)}>{source.state}</Badge>
                  </td>
                  <td>
                    {source.last_outcome}
                    {source.last_http_status !== null ? `（HTTP ${source.last_http_status}）` : ''}
                  </td>
                  <td>{formatTime(stillBlocked(source.blocked_until, report.time) ? source.blocked_until : null)}</td>
                  <td>{formatTime(source.last_success_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>

      <Section title="額度" hint="本月用量。到達硬性上限後系統自行停止請求，不付費、不換帳號。">
        <table>
          <thead>
            <tr>
              <th>供應商</th>
              <th>額度桶</th>
              <th>用量</th>
              <th>警告線</th>
              <th>硬性上限</th>
              <th>狀態</th>
            </tr>
          </thead>
          <tbody>
            {report.quota.map((bucket) => (
              <tr key={`${bucket.provider}/${bucket.bucket}`}>
                <td>{bucket.provider}</td>
                <td>{bucket.bucket}</td>
                <td>
                  <meter min={0} max={bucket.hard_stop_at} high={bucket.warn_at} optimum={0} value={bucket.used} />{' '}
                  {wholeNumber.format(bucket.used)}
                </td>
                <td>{wholeNumber.format(bucket.warn_at)}</td>
                <td>{wholeNumber.format(bucket.hard_stop_at)}</td>
                <td>
                  <Badge tone={bucket.state === 'OK' ? 'good' : bucket.state === 'WARN' ? 'warn' : 'bad'}>{bucket.state}</Badge>
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

export function App() {
  const health = useHealth();
  const report = health.kind === 'ready' ? health.report : health.kind === 'unreachable' ? health.last : null;

  return (
    <main>
      <header>
        <h1>Morrow</h1>
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
      {report ? <Report report={report} /> : null}
    </main>
  );
}
