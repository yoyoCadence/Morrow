import { MARKET_PAIRS_MAX, MARKET_WINDOWS, MarketPairsPage, type MarketWindow, type Observed, type PairSnapshotView } from '@morrow/core';
import { Fragment, useState } from 'react';
import { Link, ObservationLink } from './Evidence.js';
import { observationIdOf, shortSubject } from './evidence.js';
import {
  assetParts,
  describeObserved,
  fractionAsPercent,
  groupDigits,
  isStale,
  SNAPSHOT_STALE_MS,
  sharedNotKnown,
  shortAddress,
} from './market.js';
import { formatTime } from './time.js';
import { Ago, Badge, Section } from './ui.js';
import { usePolled } from './useResource.js';

/*
 * The market snapshot page (FT-02): the latest snapshot of every pool, from
 * GET /api/market/pairs. The first view of parser output as Observed values:
 * a value that is not KNOWN says what it is and why, and is never drawn as a
 * zero or left blank.
 */

/** Snapshots arrive with each parsed response; half a minute is soon enough, five while the tab is hidden. */
const REFRESH = { visibleMs: 30_000, hiddenMs: 300_000 } as const;

const WINDOW_LABELS: Record<MarketWindow, string> = { m5: '5 分鐘', h1: '1 小時', h6: '6 小時', h24: '24 小時' };

const asText = (value: string): string => value;

/** One Observed value: the value when KNOWN, otherwise its state and reason, with the codes in the tooltip. */
function ObservedValue<T>({ value, format }: { value: Observed<T>; format: (value: T) => string }) {
  const shown = describeObserved(value, format);
  if (shown.kind === 'known') return <>{shown.text}</>;
  return (
    <span className={`observed observed-${shown.kind}`} title={shown.title}>
      {shown.text}
    </span>
  );
}

/** A base asset: its mint, which leads to its events, with namespace and network under it. Never a symbol. */
function Token({ assetId }: { assetId: string }) {
  const { reference, network } = assetParts(assetId);
  return (
    <span title={assetId}>
      <Link to={{ page: 'evidence', subject: assetId }}>{shortAddress(reference)}</Link>
      {network ? <span className="sub">{network}</span> : null}
    </span>
  );
}

function EvidenceLinks({ refs }: { refs: readonly string[] }) {
  return (
    <>
      {refs.map((ref) => {
        const id = observationIdOf(ref);
        return <span key={ref}>{id ? <ObservationLink id={id} /> : ref} </span>;
      })}
    </>
  );
}

/** Values reported per window, one line each: the four windows side by side, or once when all four say the same thing. */
const WINDOW_METRICS: ReadonlyArray<{
  readonly label: string;
  readonly pick: (snapshot: PairSnapshotView['snapshot'], window: MarketWindow) => Observed<string>;
  readonly format: (value: string) => string;
}> = [
  { label: '買（筆）', pick: (snapshot, window) => snapshot.txns[window].buys, format: groupDigits },
  { label: '賣（筆）', pick: (snapshot, window) => snapshot.txns[window].sells, format: groupDigits },
  { label: '成交量（USD）', pick: (snapshot, window) => snapshot.volume_usd[window], format: groupDigits },
  { label: '漲跌', pick: (snapshot, window) => snapshot.price_change[window], format: fractionAsPercent },
];

function WindowFacts({ snapshot }: { snapshot: PairSnapshotView['snapshot'] }) {
  return (
    <dl className="facts">
      {WINDOW_METRICS.map((metric) => {
        const windows = MARKET_WINDOWS.map((window) => ({ window, value: metric.pick(snapshot, window) }));
        const shared = sharedNotKnown(windows.map((entry) => entry.value));
        return (
          <Fragment key={metric.label}>
            <dt>{metric.label}</dt>
            <dd>
              {shared ? (
                <>
                  各區間皆為 <ObservedValue value={shared} format={metric.format} />
                </>
              ) : (
                windows.map(({ window, value }) => (
                  <span key={window} className="window">
                    <span className="window-label">{WINDOW_LABELS[window]}</span> <ObservedValue value={value} format={metric.format} />
                  </span>
                ))
              )}
            </dd>
          </Fragment>
        );
      })}
    </dl>
  );
}

function PairFacts({ pair }: { pair: PairSnapshotView }) {
  const { snapshot } = pair;
  return (
    <dl className="facts">
      <dt>報價資產</dt>
      <dd>
        <ObservedValue value={snapshot.quote_asset} format={shortSubject} />
      </dd>
      <dt>以報價資產計價</dt>
      <dd>
        <ObservedValue value={snapshot.price_in_quote} format={groupDigits} />
      </dd>
      <dt>FDV（USD）</dt>
      <dd>
        <ObservedValue value={snapshot.fdv_usd} format={groupDigits} />
      </dd>
      <dt>市值（USD）</dt>
      <dd>
        <ObservedValue value={snapshot.market_cap_usd} format={groupDigits} />
      </dd>
      <dt>池子建立</dt>
      <dd>
        <ObservedValue value={snapshot.pool_created_at} format={(iso) => `${formatTime(iso)}（台北）`} />
      </dd>
      <dt>池子地址</dt>
      <dd className="mono">{snapshot.pool_address}</dd>
      <dt>來源</dt>
      <dd>
        {pair.provider} · {pair.parser_version}
      </dd>
      <dt>收到回應</dt>
      <dd>{formatTime(pair.observed_at)}（台北）· 來源沒有提供自己的時間</dd>
      <dt>證據</dt>
      <dd>
        <EvidenceLinks refs={pair.evidence_refs} />
      </dd>
    </dl>
  );
}

const COLUMNS = 8;

function PairRow({ pair, now }: { pair: PairSnapshotView; now: number }) {
  const [open, setOpen] = useState(false);
  const { snapshot } = pair;
  const stale = isStale(pair.observed_at, now);
  const detailId = `pair-${pair.event_id}`;
  return (
    <>
      <tr>
        <td className="cell-primary" data-label="代幣">
          <Token assetId={snapshot.base_asset} />
        </td>
        <td data-label="池子">
          <span>
            <ObservedValue value={snapshot.venue} format={asText} />
            {snapshot.venue_labels.length > 0 ? ` · ${snapshot.venue_labels.join(', ')}` : ''}
            <span className="sub mono" title={snapshot.pool_address}>
              {shortAddress(snapshot.pool_address)}
            </span>
          </span>
        </td>
        <td data-label="價格（USD）" className="num">
          <ObservedValue value={snapshot.price_usd} format={groupDigits} />
        </td>
        <td data-label="流動性（USD）" className="num">
          <ObservedValue value={snapshot.liquidity_usd} format={groupDigits} />
        </td>
        <td data-label="24 小時買／賣" className="num">
          <span>
            <ObservedValue value={snapshot.txns.h24.buys} format={groupDigits} /> /{' '}
            <ObservedValue value={snapshot.txns.h24.sells} format={groupDigits} />
          </span>
        </td>
        <td data-label="24 小時成交量（USD）" className="num">
          <ObservedValue value={snapshot.volume_usd.h24} format={groupDigits} />
        </td>
        <td data-label="觀測">
          <span>
            <Ago iso={pair.observed_at} now={now} />
            {stale ? (
              <>
                {' '}
                <Badge tone="warn">過時</Badge>
              </>
            ) : null}
          </span>
        </td>
        <td data-label="細節">
          <button type="button" className="link-button" aria-expanded={open} aria-controls={detailId} onClick={() => setOpen(!open)}>
            {open ? '收起' : '展開'}
          </button>
        </td>
      </tr>
      {open ? (
        <tr className="detail-row" id={detailId}>
          <td colSpan={COLUMNS}>
            <div className="pair-detail">
              <WindowFacts snapshot={snapshot} />
              <PairFacts pair={pair} />
            </div>
          </td>
        </tr>
      ) : null}
    </>
  );
}

function Summary({ page, now }: { page: MarketPairsPage; now: number }) {
  const tokens = new Set(page.pairs.map((pair) => pair.snapshot.base_asset)).size;
  const stale = page.pairs.filter((pair) => isStale(pair.observed_at, now)).length;
  // Timestamps from the API are all toISOString(), so they compare as text.
  const newest = page.pairs.reduce<string | null>((latest, pair) => (latest === null || pair.observed_at > latest ? pair.observed_at : latest), null);
  return (
    <p className="market-summary">
      {page.pairs.length} 個池子 · {tokens} 個代幣 · 最新一筆收到於 <Ago iso={newest} now={now} />
      {stale > 0 ? (
        <>
          {' '}
          <Badge tone="warn">
            {stale} 個超過 {SNAPSHOT_STALE_MS / 60_000} 分鐘
          </Badge>
        </>
      ) : null}
    </p>
  );
}

function Problems({ page }: { page: MarketPairsPage }) {
  return (
    <>
      {page.truncated ? (
        <p className="alert" role="alert">
          有 snapshot 的池子超過 {MARKET_PAIRS_MAX} 個，這裡只列出依地址排序的前 {MARKET_PAIRS_MAX} 個。
        </p>
      ) : null}
      {page.rejected.length > 0 ? (
        <div className="alert" role="alert">
          <p>以下池子最新一筆 snapshot 無法顯示，也不會改用更舊的一筆代替：</p>
          <ul className="event-list">
            {page.rejected.map((entry) => (
              <li key={entry.event_id}>
                <span className="mono" title={entry.pool_address}>
                  {shortAddress(entry.pool_address)}
                </span>{' '}
                ·{' '}
                {entry.problem === 'PAYLOAD_VERSION'
                  ? '資料格式版本較新，這個版本的儀表板讀不了：請更新並重新建置'
                  : '內容不符合 PairSnapshot 契約'}{' '}
                · 事件 #{entry.recorded_seq}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </>
  );
}

export function MarketPage({ now }: { now: number }) {
  const market = usePolled('/api/market/pairs', MarketPairsPage, REFRESH);
  const page = market.data;
  return (
    <Section
      title="市場快照"
      hint="每個池子最新的一筆 snapshot，依代幣分組，流動性高的池子在前。這是聚合器顯示的狀態，不是可成交的報價；兩個聚合器讀同一個池子，不算互相確認。"
    >
      {market.error !== null ? (
        <p className="alert" role="alert">
          無法更新（{market.error}）。{page ? '以下是最後一次取得的資料。' : ''}
        </p>
      ) : null}
      {page === null && market.error === null ? <p className="empty">讀取中…</p> : null}
      {page !== null ? (
        <>
          <Problems page={page} />
          {page.pairs.length === 0 && page.rejected.length === 0 ? (
            <p className="empty">
              還沒有任何市場 snapshot。DEX Screener 的回應經過 parser 處理後才會出現在這裡；目前沒有固定排程，資料只來自送出的請求（例如 npm run probe）。
            </p>
          ) : null}
          {page.pairs.length > 0 ? (
            <>
              <Summary page={page} now={now} />
              <table className="market-pairs responsive">
                <thead>
                  <tr>
                    <th scope="col">代幣</th>
                    <th scope="col">池子</th>
                    <th scope="col" className="num">
                      價格（USD）
                    </th>
                    <th scope="col" className="num">
                      流動性（USD）
                    </th>
                    <th scope="col" className="num">
                      24h 買／賣
                    </th>
                    <th scope="col" className="num">
                      24h 成交量（USD）
                    </th>
                    <th scope="col">觀測</th>
                    <th scope="col">細節</th>
                  </tr>
                </thead>
                <tbody>
                  {page.pairs.map((pair) => (
                    <PairRow key={pair.event_id} pair={pair} now={now} />
                  ))}
                </tbody>
              </table>
            </>
          ) : null}
        </>
      ) : null}
    </Section>
  );
}
