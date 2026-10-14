import type { ReactNode } from 'react';
import type { Tone } from './status.js';
import { formatRelative, formatTime } from './time.js';

/* Building blocks shared by the dashboard's pages. */

export function Badge({ tone, children }: { tone: Tone; children: ReactNode }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

export function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section className="card">
      <h2>{title}</h2>
      {hint ? <p className="hint">{hint}</p> : null}
      {children}
    </section>
  );
}

/** A relative time such as "12 秒前", with the full Taipei time as its tooltip. */
export function Ago({ iso, now }: { iso: string | null; now: number }) {
  if (iso === null) return <>—</>;
  return (
    <time dateTime={iso} title={`${formatTime(iso)}（台北）`}>
      {formatRelative(Date.parse(iso), now)}
    </time>
  );
}
