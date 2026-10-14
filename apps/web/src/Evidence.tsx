import {
  EventPage,
  EventSubject,
  QuarantinePage,
  RAW_BODY_PREVIEW_BYTES,
  RawObservationDetail,
  RawObservationPage,
  type QuarantineEntryView,
  type RawObservationView,
  type StoredEvent,
} from '@morrow/core';
import { type FormEvent, type MouseEvent, type ReactNode, useState } from 'react';
import { formatSize, observationIdOf, outcomeTone, prettyBody, prettyJson, shortSubject } from './evidence.js';
import { navigate, type Route, routePath } from './route.js';
import { formatTime } from './time.js';
import { Ago, Badge, Section } from './ui.js';
import { type PagedList, usePagedList, useResource } from './useResource.js';

/*
 * The evidence browser (FT-01): what was observed, what was made of it, and
 * what the parser refused to guess. Everything shown here comes from the
 * read-only /api/events, /api/raw-observations and /api/quarantine
 * endpoints, checked against the shared contract. Text from providers is
 * shown as text, never as markup, and arrives already redacted.
 */

/** An in-page link: a real href for new tabs and copying, navigation without a reload otherwise. */
export function Link({ to, children, current }: { to: Route; children: ReactNode; current?: boolean }) {
  const onClick = (event: MouseEvent<HTMLAnchorElement>): void => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    navigate(to);
  };
  return (
    <a href={routePath(to)} onClick={onClick} aria-current={current ? 'page' : undefined}>
      {children}
    </a>
  );
}

function SubjectLink({ subject }: { subject: string }) {
  return (
    <span title={subject}>
      <Link to={{ page: 'evidence', subject }}>{shortSubject(subject)}</Link>
    </span>
  );
}

function ObservationLink({ id }: { id: string }) {
  return <Link to={{ page: 'observation', id }}>#{id}</Link>;
}

function MoreButton({ list, label }: { list: PagedList<unknown>; label: string }) {
  // A failed page keeps its cursor, so trying again asks for that same page; what was loaded stays.
  if (list.state === 'error') {
    return (
      <p className="alert" role="alert">
        無法取得（{list.error}）。{' '}
        <button type="button" onClick={list.loadMore}>
          重試
        </button>
      </p>
    );
  }
  if (!list.hasMore) return null;
  return (
    <button type="button" className="more" onClick={list.loadMore} disabled={list.state === 'more'}>
      {list.state === 'more' ? '讀取中…' : label}
    </button>
  );
}

const pickEvents = (page: EventPage) => ({ items: page.events, next: page.next_before });
const pickObservations = (page: RawObservationPage) => ({ items: page.observations, next: page.next_before });
const pickQuarantine = (page: QuarantinePage) => ({ items: page.entries, next: page.next_before });

function SubjectFilter({ subject }: { subject: string | null }) {
  const [draft, setDraft] = useState(subject ?? '');
  const [invalid, setInvalid] = useState(false);
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    const value = draft.trim();
    const valid = value === '' || EventSubject.safeParse(value).success;
    setInvalid(!valid);
    if (valid) navigate({ page: 'evidence', subject: value === '' ? null : value });
  };
  return (
    <form className="subject-filter" onSubmit={submit}>
      <label>
        Subject
        <input
          type="text"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="solana:mainnet-beta:<mint>"
          spellCheck={false}
          aria-invalid={invalid}
          aria-describedby="subject-hint"
        />
      </label>
      <button type="submit">查詢</button>
      {subject !== null ? (
        <button type="button" onClick={() => navigate({ page: 'evidence', subject: null })}>
          全部
        </button>
      ) : null}
      <p id="subject-hint" className={invalid ? 'alert' : 'hint'}>
        {invalid
          ? '這不是有效的 subject。資產是 namespace:network:reference，例如 solana:mainnet-beta: 加上 mint；不能用代號。'
          : '資產以 namespace:network:reference 識別，Solana 的 reference 是 mint，不是代號。'}
      </p>
    </form>
  );
}

function EventRow({ event, now }: { event: StoredEvent; now: number }) {
  // The payload opens in a row of its own, as wide as the table: inside a cell it would squeeze every other column.
  const [open, setOpen] = useState(false);
  const detailId = `event-${event.event_id}`;
  return (
    <>
      <tr>
        <td className="cell-primary" data-label="事件">
          {event.domain} · {event.action}
        </td>
        <td data-label="Subject">
          <SubjectLink subject={event.subject} />
        </td>
        <td data-label="收到">
          <Ago iso={event.available_at} now={now} />
        </td>
        <td data-label="來源時間" className={event.event_time === null ? 'muted-cell' : undefined}>
          {event.event_time === null ? '來源未提供' : formatTime(event.event_time)}
        </td>
        <td data-label="證據">
          {event.provenance.evidence_refs.map((ref) => {
            const id = observationIdOf(ref);
            return <span key={ref}>{id ? <ObservationLink id={id} /> : ref} </span>;
          })}
        </td>
        <td data-label="內容">
          <button type="button" className="link-button" aria-expanded={open} aria-controls={detailId} onClick={() => setOpen(!open)}>
            {open ? '收起' : '展開'}
          </button>
        </td>
      </tr>
      {open ? (
        <tr className="detail-row" id={detailId}>
          <td colSpan={6}>
            <pre className="json">{prettyJson({ payload: event.payload, provenance: event.provenance, dedupe_key: event.dedupe_key })}</pre>
          </td>
        </tr>
      ) : null}
    </>
  );
}

function EventsSection({ subject, now }: { subject: string | null; now: number }) {
  const url = subject === null ? '/api/events' : `/api/events?subject=${encodeURIComponent(subject)}`;
  const list = usePagedList(url, EventPage, pickEvents);
  return (
    <Section
      title={subject === null ? '事件' : `事件 · ${shortSubject(subject)}`}
      hint="Parser 從原始回應產生的事件，新的在前。每一筆都可以點「證據」追到它依據的原始回應。"
    >
      <SubjectFilter key={subject ?? ''} subject={subject} />
      {list.state === 'loading' ? <p className="empty">讀取中…</p> : null}
      {list.state !== 'loading' && list.items.length === 0 && list.state !== 'error' ? (
        <p className="empty">{subject === null ? '還沒有任何事件。' : '這個 subject 沒有事件。'}</p>
      ) : null}
      {list.items.length > 0 ? (
        <table className="evidence-events responsive">
          <caption className="visually-hidden">事件，新的在前</caption>
          <thead>
            <tr>
              <th scope="col">事件</th>
              <th scope="col">Subject</th>
              <th scope="col">收到</th>
              <th scope="col">來源時間</th>
              <th scope="col">證據</th>
              <th scope="col">內容</th>
            </tr>
          </thead>
          <tbody>
            {list.items.map((event) => (
              <EventRow key={event.event_id} event={event} now={now} />
            ))}
          </tbody>
        </table>
      ) : null}
      <MoreButton list={list} label="更早的事件" />
    </Section>
  );
}

function OutcomeBadge({ observation }: { observation: RawObservationView }) {
  return (
    <Badge tone={outcomeTone(observation.outcome)}>
      {observation.outcome}
      {observation.http_status !== null ? ` · ${observation.http_status}` : ''}
    </Badge>
  );
}

function ObservationsSection({ now }: { now: number }) {
  const list = usePagedList('/api/raw-observations', RawObservationPage, pickObservations);
  return (
    <Section title="原始觀測" hint="每一個送出過的請求，不論成敗。點編號看原始回應、從它產生的事件與 quarantine 的欄位。">
      {list.state === 'loading' ? <p className="empty">讀取中…</p> : null}
      {list.state === 'ready' && list.items.length === 0 ? <p className="empty">還沒有送出過任何請求。</p> : null}
      {list.items.length > 0 ? (
        <table className="evidence-observations responsive">
          <caption className="visually-hidden">送出過的請求，新的在前</caption>
          <thead>
            <tr>
              <th scope="col">編號</th>
              <th scope="col">來源</th>
              <th scope="col">結果</th>
              <th scope="col">收到</th>
              <th scope="col">本文</th>
            </tr>
          </thead>
          <tbody>
            {list.items.map((observation) => (
              <tr key={observation.id}>
                <td className="cell-primary" data-label="編號">
                  <ObservationLink id={observation.id} />
                </td>
                <td data-label="來源">
                  {observation.provider} / {observation.capability}
                </td>
                <td className="cell-status" data-label="結果">
                  <OutcomeBadge observation={observation} />
                </td>
                <td data-label="收到">
                  <Ago iso={observation.observed_at} now={now} />
                </td>
                <td data-label="本文" className={observation.byte_length === null ? 'is-empty' : undefined}>
                  {observation.byte_length === null ? '—' : formatSize(observation.byte_length)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      <MoreButton list={list} label="更早的請求" />
    </Section>
  );
}

function QuarantineTable({ entries, withObservation }: { entries: readonly QuarantineEntryView[]; withObservation: boolean }) {
  return (
    <table className="evidence-quarantine responsive">
      <caption className="visually-hidden">Parser 不猜測解讀的欄位</caption>
      <thead>
        <tr>
          <th scope="col">欄位</th>
          <th scope="col">原因</th>
          <th scope="col">原文</th>
          <th scope="col">對象</th>
          {withObservation ? <th scope="col">觀測</th> : null}
          <th scope="col">Parser</th>
        </tr>
      </thead>
      <tbody>
        {entries.map((entry) => (
          <tr key={entry.id}>
            <td className="cell-primary mono" data-label="欄位">
              {entry.field_path}
            </td>
            <td className="cell-status" data-label="原因">
              <Badge tone="warn">{entry.reason}</Badge>
            </td>
            <td className="mono" data-label="原文">
              {entry.raw_value ?? '（不是單一值）'}
            </td>
            <td className="mono" data-label="對象">
              {entry.record_ref}
            </td>
            {withObservation ? (
              <td data-label="觀測">
                <ObservationLink id={entry.raw_observation_id} />
              </td>
            ) : null}
            <td data-label="Parser">{entry.parser_version}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function QuarantineSection() {
  const list = usePagedList('/api/quarantine', QuarantinePage, pickQuarantine);
  return (
    <Section title="Quarantine" hint="Parser 收到、但不猜測解讀的欄位（例如單位未確認）。原文保留下來，等規則確認後重新解析。">
      {list.state === 'loading' ? <p className="empty">讀取中…</p> : null}
      {list.state === 'ready' && list.items.length === 0 ? <p className="empty">沒有被 quarantine 的欄位。</p> : null}
      {list.items.length > 0 ? <QuarantineTable entries={list.items} withObservation /> : null}
      <MoreButton list={list} label="更早的欄位" />
    </Section>
  );
}

export function EvidencePage({ subject, now }: { subject: string | null; now: number }) {
  return (
    <>
      <EventsSection subject={subject} now={now} />
      <ObservationsSection now={now} />
      <QuarantineSection />
    </>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </>
  );
}

function ObservationFacts({ observation }: { observation: RawObservationView }) {
  return (
    <dl className="facts">
      <Fact label="來源">
        {observation.provider} / {observation.capability}（{observation.provider_group}）
      </Fact>
      <Fact label="請求">
        <span className="mono">
          {observation.request_method} {observation.request_url}
        </span>
      </Fact>
      <Fact label="原因">{observation.reason}</Fact>
      <Fact label="結果">
        <OutcomeBadge observation={observation} />
      </Fact>
      {observation.error_class !== null || observation.error_detail !== null ? (
        <Fact label="錯誤">{[observation.error_class, observation.error_detail].filter(Boolean).join(' · ')}</Fact>
      ) : null}
      <Fact label="Content-Type">{observation.content_type ?? '—'}</Fact>
      <Fact label="收到">{formatTime(observation.observed_at)}（台北）</Fact>
      <Fact label="可用">{formatTime(observation.available_at)}（台北）</Fact>
      <Fact label="供應商時間">
        {observation.server_date === null
          ? '回應沒有 Date header'
          : `${formatTime(observation.server_date)}（偏移 ${observation.clock_offset_ms ?? '?'} ms）`}
      </Fact>
      <Fact label="耗時">{observation.duration_ms === null ? '—' : `${observation.duration_ms} ms`}</Fact>
    </dl>
  );
}

function Body({ detail }: { detail: RawObservationDetail }) {
  const body = detail.body;
  if (body === null) return <p className="empty">沒有本文：這個請求沒有收到回應，或回應沒有內容。</p>;
  if (body.text === null) {
    return <p className="empty">本文不是 UTF-8 文字（{formatSize(body.byte_length)}），這裡不顯示。原始位元組保存在資料庫。</p>;
  }
  return (
    <>
      {body.truncated ? (
        <p className="hint">
          只顯示前 {formatSize(RAW_BODY_PREVIEW_BYTES)}，全文 {formatSize(body.byte_length)}；完整內容保存在資料庫。
        </p>
      ) : null}
      {body.redacted ? <p className="hint">看起來像憑證的內容已遮蔽為 [REDACTED]；資料庫裡的原始內容不變。</p> : null}
      <pre className="body">{prettyBody(body.text, body.truncated)}</pre>
      <p className="hint mono">SHA-256 {body.sha256}</p>
    </>
  );
}

export function ObservationPage({ id }: { id: string }) {
  const resource = useResource(`/api/raw-observations/${id}`, RawObservationDetail);
  return (
    <>
      <p className="back">
        <Link to={{ page: 'evidence', subject: null }}>← 證據</Link>
      </p>
      {resource.kind === 'loading' ? <p className="empty">讀取中…</p> : null}
      {resource.kind === 'error' ? (
        <p className="alert" role="alert">
          {resource.message === 'HTTP 404' ? `沒有編號 ${id} 的觀測。` : `無法取得這筆觀測（${resource.message}）。`}
        </p>
      ) : null}
      {resource.kind === 'ready' ? (
        <>
          <Section title={`觀測 #${id}`}>
            <ObservationFacts observation={resource.data.observation} />
          </Section>
          <Section title="原始回應" hint="供應商回傳的內容，格式化後顯示；數字與文字照原樣，不重新解讀。">
            <Body detail={resource.data} />
          </Section>
          <Section title="產生的事件" hint="在 provenance 中引用這筆觀測的事件。">
            {resource.data.events.length === 0 ? (
              <p className="empty">沒有事件引用這筆觀測（請求失敗、還沒解析，或這個功能沒有 parser）。</p>
            ) : (
              <ul className="event-list">
                {resource.data.events.map((event) => (
                  <li key={event.event_id}>
                    {event.domain} · {event.action} · <SubjectLink subject={event.subject} />
                  </li>
                ))}
              </ul>
            )}
            {resource.data.events_truncated ? <p className="hint">只列出前 {resource.data.events.length} 筆。</p> : null}
          </Section>
          <Section title="Quarantine 的欄位" hint="Parser 從這筆回應收到、但不猜測解讀的欄位。">
            {resource.data.quarantine.length === 0 ? (
              <p className="empty">沒有。</p>
            ) : (
              <QuarantineTable entries={resource.data.quarantine} withObservation={false} />
            )}
          </Section>
        </>
      ) : null}
    </>
  );
}
