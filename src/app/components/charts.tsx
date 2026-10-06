/**
 * The Overview's charts, as HTML and CSS rather than SVG: weekly columns, a proportion bar,
 * ranked bars and histogram columns (src/app/model/charts.ts picks which). Every mark uses
 * --accent; parts of a whole use the same blue at falling opacity. Every mark is a link
 * into the Table with that filter, answers hover and focus with a tooltip, and every card
 * can switch to a table holding the same numbers.
 */

import { useEffect, useId, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { formatCount } from '../format';
import { prefersReducedMotion } from '../hooks';
import type { Takeaway } from '../model/charts';
import { Link } from '../router';
import { Icon, Segmented, ShowAll } from '../ui';

/** Marks grow in the first time a chart is seen in this tab, not on every visit. */
const seen = new Set<string>();

function useGrowOnce(key: string): boolean {
  const [grow] = useState(() => !seen.has(key) && !prefersReducedMotion());
  useEffect(() => {
    seen.add(key);
  }, [key]);
  return grow;
}

export function TakeawayLine({ parts }: { parts: Takeaway }) {
  return (
    <p className="takeaway">
      {parts.map((part, index) => (part.strong ? <b key={index}>{part.text}</b> : <span key={index}>{part.text}</span>))}
    </p>
  );
}

/* ───────── frame ───────── */

export interface TableRow {
  label: string;
  value: number;
  href?: string;
}

/** A chart's frame: title, Chart/Table toggle, takeaway, then the plot or its numbers as a table. */
export function ChartFrame({
  id,
  title,
  takeaway,
  head,
  rows,
  full,
  children,
}: {
  /** Stable per chart, so the grow-in plays once. */
  id: string;
  title: string;
  takeaway: Takeaway;
  head: [string, string];
  rows: readonly TableRow[];
  full?: boolean;
  children: (grow: boolean) => ReactNode;
}) {
  const [view, setView] = useState<'chart' | 'table'>('chart');
  const headingId = useId();
  const grow = useGrowOnce(id);
  return (
    <section className={full ? 'chart full' : 'chart'} aria-labelledby={headingId}>
      <div className="chart-head">
        <h2 id={headingId}>{title}</h2>
        <Segmented
          label={`Show ${title} as`}
          value={view}
          onChange={setView}
          choices={[
            { value: 'chart', label: 'Chart' },
            { value: 'table', label: 'Table' },
          ]}
        />
      </div>
      <TakeawayLine parts={takeaway} />
      {view === 'table' ? (
        <table className="mini-table">
          <caption className="visually-hidden">{title}</caption>
          <thead>
            <tr>
              <th scope="col">{head[0]}</th>
              <th scope="col">{head[1]}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.label}>
                <td>{row.href ? <Link href={row.href}>{row.label}</Link> : row.label}</td>
                <td>{formatCount(row.value)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <div className={grow ? 'grow-in' : undefined}>{children(grow)}</div>
      )}
    </section>
  );
}

/* ───────── columns ───────── */

export interface ColumnItem {
  key: string;
  value: number;
  href: string;
  /** Tooltip and accessible name, e.g. "Week of Sep 14 · 45 rounds". */
  tip: string;
  now?: boolean;
  later?: boolean;
}

/**
 * Vertical columns from one baseline, with gridlines at 0, half and top. `labels` sit at
 * fractions of the width (months under weeks); `ticks` sit one under each column (bins).
 */
export function Columns({
  items,
  top,
  todayAt,
  labels,
  ticks,
}: {
  items: readonly ColumnItem[];
  top: number;
  todayAt?: number | null;
  labels?: readonly { at: number; text: string }[];
  ticks?: readonly string[];
}) {
  const plot = useRef<HTMLDivElement>(null);
  const [tip, setTip] = useState<{ x: number; y: number; text: string } | null>(null);

  const show = (element: HTMLElement, item: ColumnItem) => {
    const box = plot.current;
    if (!box) return;
    const bar = element.firstElementChild as HTMLElement | null;
    const x = Math.max(60, Math.min(box.clientWidth - 60, element.offsetLeft + element.offsetWidth / 2));
    setTip({ x, y: box.clientHeight - (bar?.offsetHeight ?? 0) - 6, text: item.tip });
  };

  return (
    <div className={todayAt !== null && todayAt !== undefined ? 'columns-wrap has-today' : 'columns-wrap'}>
      <div ref={plot} className={ticks ? 'columns bins' : 'columns'} onPointerLeave={() => setTip(null)}>
        {[0, top / 2, top].map((value) => (
          <div key={value} className="gridline" style={{ bottom: `${(value / top) * 100}%` }} aria-hidden="true">
            <span>{formatCount(value)}</span>
          </div>
        ))}
        {items.map((item, index) => (
          <Link
            key={item.key}
            href={item.href}
            className={['col', item.value === 0 && 'zero', item.now && 'now', item.later && 'later', tip?.text === item.tip && 'hot']
              .filter(Boolean)
              .join(' ')}
            style={{ ['--i' as string]: index } as CSSProperties}
            aria-label={`${item.tip}. Show in the table`}
            onPointerEnter={(event) => show(event.currentTarget, item)}
            onFocus={(event) => show(event.currentTarget, item)}
            onBlur={() => setTip(null)}
          >
            <i style={{ height: `${Math.max(item.value > 0 ? 2 : 1, (item.value / top) * 100)}%` }} />
          </Link>
        ))}
        {todayAt !== null && todayAt !== undefined ? (
          <span className="today-line" style={{ left: `${todayAt * 100}%` }} aria-hidden="true">
            <span>Today</span>
          </span>
        ) : null}
        {tip ? (
          <div className="chart-tip" style={{ left: tip.x, top: tip.y }} aria-hidden="true">
            {tip.text}
          </div>
        ) : null}
      </div>
      {ticks ? (
        <div className="x-labels even" aria-hidden="true">
          {ticks.map((tick, index) => (
            <span key={index}>{tick}</span>
          ))}
        </div>
      ) : (
        <div className="x-labels" aria-hidden="true">
          {(labels ?? []).map((label) => (
            <span key={`${label.at}`} style={{ left: `${label.at * 100}%` }}>
              {label.text}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

/* ───────── categories ───────── */

export interface CategoryItem {
  key: string;
  label: string;
  count: number;
  /** Share shown on the right, e.g. "23%". */
  share: string;
  href: string;
}

/** The same blue at falling opacity, one step per part of the whole. */
const SHADES = [1, 0.7, 0.48, 0.3, 0.18];

/** One proportion bar and a legend: for a few categories that make up a whole. */
export function ShareBar({ items, noun }: { items: readonly CategoryItem[]; noun: (count: number) => string }) {
  const total = items.reduce((sum, item) => sum + item.count, 0);
  return (
    <>
      <div className="share" aria-hidden="true">
        {items
          .filter((item) => item.count > 0)
          .map((item, index) => (
            <i key={item.key} style={{ width: `${(item.count / Math.max(1, total)) * 100}%`, opacity: SHADES[Math.min(index, 4)] }} />
          ))}
      </div>
      {items.map((item, index) => (
        <Link
          key={item.key}
          href={item.href}
          className={item.count === 0 ? 'legend-row zero' : 'legend-row'}
          aria-label={`${item.label}: ${noun(item.count)}, ${item.share}. Show in the table`}
        >
          <span className="dot" style={{ opacity: item.count > 0 ? SHADES[Math.min(index, 4)] : 0.18 }} aria-hidden="true" />
          <span>{item.label}</span>
          <span className="count">{formatCount(item.count)}</span>
          <span className="pct">{item.share}</span>
        </Link>
      ))}
    </>
  );
}

/** Ranked bars, longest first: the top ones, then "Show all". */
export function RankedBars({ items, top, noun }: { items: readonly CategoryItem[]; top: number; noun: (count: number) => string }) {
  const [all, setAll] = useState(false);
  const max = Math.max(1, ...items.map((item) => item.count));
  const shown = all ? items : items.slice(0, top);
  return (
    <>
      {shown.map((item, index) => (
        <Link key={item.key} href={item.href} className="bar-row" aria-label={`${item.label}: ${noun(item.count)}, ${item.share}. Show in the table`}>
          <span className="name">{item.label}</span>
          <span className="track" aria-hidden="true">
            <i style={{ width: `${(item.count / max) * 100}%`, ['--i' as string]: index } as CSSProperties} />
          </span>
          <span className="count">{formatCount(item.count)}</span>
          <span className="pct">{item.share}</span>
        </Link>
      ))}
      {items.length > top ? <ShowAll expanded={all} total={items.length} less={`Show top ${top}`} onToggle={() => setAll(!all)} /> : null}
    </>
  );
}

/** The line above a histogram when few records state its value. */
export function Coverage({ text, share }: { text: string; share: number }) {
  return (
    <div className="coverage">
      <Icon name="warn" size={15} />
      <span>{text}</span>
      <span className="track" aria-hidden="true">
        <i style={{ width: `${share * 100}%` }} />
      </span>
    </div>
  );
}
