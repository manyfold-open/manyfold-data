/**
 * The Overview's charts, drawn as plain SVG. Every chart here plots one series, so all
 * marks share one color (--series-1) and no legend; the card title names what is
 * plotted. Marks are thin, with a 4px rounded data end and a square baseline. Each mark
 * answers hover and keyboard focus with a tooltip, and every card can switch to a table
 * holding the same numbers.
 */

import { useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { formatCount } from '../format';

/** An element's content width, kept current as the layout changes. */
function useWidth<T extends HTMLElement>(): [RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(Math.floor(entry.contentRect.width));
    });
    observer.observe(element);
    setWidth(Math.floor(element.getBoundingClientRect().width));
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}

/** Round, whole-number ticks from 0 to at least `max`. */
export function countTicks(max: number, target = 4): number[] {
  if (max <= 0) return [0, 1];
  const raw = max / target;
  const power = 10 ** Math.floor(Math.log10(raw));
  const step = Math.max(1, [1, 2, 5, 10].map((m) => m * power).find((candidate) => candidate >= raw) ?? raw);
  const top = Math.ceil(max / step) * step;
  return Array.from({ length: Math.round(top / step) + 1 }, (_, i) => i * step);
}

/** A column with a 4px rounded top and a square base. */
function columnPath(x: number, y: number, width: number, height: number): string {
  const r = Math.min(4, width / 2, height);
  return `M${x},${y + height}V${y + r}Q${x},${y} ${x + r},${y}H${x + width - r}Q${x + width},${y} ${x + width},${y + r}V${y + height}Z`;
}

/** A bar with a 4px rounded right end and a square left base. */
function barPath(x: number, y: number, width: number, height: number): string {
  const r = Math.min(4, height / 2, width);
  return `M${x},${y}H${x + width - r}Q${x + width},${y} ${x + width},${y + r}V${y + height - r}Q${x + width},${y + height} ${x + width - r},${y + height}H${x}Z`;
}

interface Tip {
  x: number;
  y: number;
  value: string;
  label: string;
}

function Tooltip({ tip }: { tip: Tip | null }) {
  if (!tip) return null;
  return (
    <div className="tooltip" style={{ left: tip.x, top: tip.y }} role="status">
      <strong>{tip.value}</strong>
      <span>{tip.label}</span>
    </div>
  );
}

/* ───────── card ───────── */

export interface TableView {
  columns: [string, string];
  rows: [string, string][];
}

/** A chart's frame: title, the plot or its table, and an optional note under it. */
export function ChartCard({
  title,
  table,
  note,
  wide,
  children,
}: {
  title: string;
  table: TableView;
  note?: ReactNode;
  wide?: boolean;
  children: ReactNode;
}) {
  const [showTable, setShowTable] = useState(false);
  return (
    <figure className={wide ? 'chart-card wide' : 'chart-card'}>
      <div className="chart-head">
        <figcaption>{title}</figcaption>
        <button type="button" className="quiet-button" aria-pressed={showTable} onClick={() => setShowTable(!showTable)}>
          {showTable ? 'Show chart' : 'Show table'}
        </button>
      </div>
      {showTable ? (
        <table className="chart-table">
          <thead>
            <tr>
              <th scope="col">{table.columns[0]}</th>
              <th scope="col" className="num">
                {table.columns[1]}
              </th>
            </tr>
          </thead>
          <tbody>
            {table.rows.map(([label, value]) => (
              <tr key={label}>
                <td>{label}</td>
                <td className="num">{value}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        children
      )}
      {note ? <p className="chart-note">{note}</p> : null}
    </figure>
  );
}

/* ───────── columns ───────── */

export interface Column {
  key: string;
  /** Axis label under the column. */
  tick: string;
  /** Full name, for the tooltip. */
  label: string;
  value: number;
  /** Bold axis label: the week or month that contains today. */
  current?: boolean;
}

const MARGIN = { top: 22, right: 8, bottom: 30, left: 36 };

/**
 * Vertical columns from one baseline. `labels`: 'all' prints every non-zero value on
 * its column (for a few columns); 'max' prints only the tallest.
 */
export function ColumnChart({
  columns,
  describe,
  labels,
  height = 220,
}: {
  columns: Column[];
  /** Tooltip value, e.g. "3 hackathons". */
  describe: (value: number) => string;
  labels: 'all' | 'max';
  height?: number;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [active, setActive] = useState<number | null>(null);

  const plotWidth = Math.max(0, width - MARGIN.left - MARGIN.right);
  const plotHeight = height - MARGIN.top - MARGIN.bottom;
  const ticks = countTicks(Math.max(0, ...columns.map((column) => column.value)));
  const top = ticks.at(-1) ?? 1;
  const y = (value: number) => MARGIN.top + plotHeight - (value / top) * plotHeight;
  const band = columns.length > 0 ? plotWidth / columns.length : 0;
  const barWidth = Math.max(2, Math.min(24, band - 2, band * 0.7));
  // Thin the axis labels so the widest one never touches its neighbour.
  const labelWidth = Math.max(0, ...columns.map((column) => column.tick.length)) * 6.6 + 12;
  const every = Math.max(1, Math.ceil(labelWidth / Math.max(band, 1)));
  const tallest = columns.reduce((best, column, index) => (column.value > (columns[best]?.value ?? 0) ? index : best), 0);
  const center = (index: number) => MARGIN.left + band * index + band / 2;

  const tipFor = (index: number): Tip | null => {
    const column = columns[index];
    return column ? { x: center(index), y: y(column.value) - 8, value: describe(column.value), label: column.label } : null;
  };

  return (
    <div className="chart-plot" ref={ref}>
      {width > 0 ? (
        <svg width={width} height={height} className="chart-svg" role="group">
          {ticks.map((tick) => (
            <g key={tick}>
              <line
                x1={MARGIN.left}
                x2={width - MARGIN.right}
                y1={y(tick)}
                y2={y(tick)}
                className={tick === 0 ? 'axis-line' : 'grid-line'}
              />
              <text x={MARGIN.left - 8} y={y(tick)} dy="0.32em" textAnchor="end" className="tick-label">
                {formatCount(tick)}
              </text>
            </g>
          ))}
          {columns.map((column, index) => {
            const showValue = column.value > 0 && (labels === 'all' || index === tallest);
            return (
              <g key={column.key}>
                {column.value > 0 ? (
                  <path
                    d={columnPath(center(index) - barWidth / 2, y(column.value), barWidth, y(0) - y(column.value))}
                    className={active === index ? 'mark active' : 'mark'}
                  />
                ) : null}
                {showValue ? (
                  <text x={center(index)} y={y(column.value) - 6} textAnchor="middle" className="value-label">
                    {formatCount(column.value)}
                  </text>
                ) : null}
                {index % every === 0 ? (
                  <text
                    x={center(index)}
                    y={height - 10}
                    textAnchor="middle"
                    className={column.current ? 'tick-label current' : 'tick-label'}
                  >
                    {column.tick}
                  </text>
                ) : null}
              </g>
            );
          })}
          {columns.map((column, index) => (
            <rect
              key={column.key}
              x={MARGIN.left + band * index}
              y={MARGIN.top}
              width={band}
              height={plotHeight}
              className="hit"
              tabIndex={0}
              aria-label={`${column.label}: ${describe(column.value)}`}
              onPointerEnter={() => setActive(index)}
              onPointerLeave={() => setActive(null)}
              onFocus={() => setActive(index)}
              onBlur={() => setActive(null)}
            />
          ))}
        </svg>
      ) : null}
      <Tooltip tip={active === null ? null : tipFor(active)} />
    </div>
  );
}

/* ───────── bars ───────── */

export interface Bar {
  key: string;
  label: string;
  value: number;
}

/** Horizontal bars, one per category, each value printed at its tip. */
export function BarChart({ bars, describe }: { bars: Bar[]; describe: (value: number) => string }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [active, setActive] = useState<number | null>(null);

  const rowHeight = 36;
  const barHeight = 16;
  const labelWidth = Math.min(160, Math.max(72, ...bars.map((bar) => bar.label.length * 7.2 + 14)));
  const valueWidth = 48;
  const plotWidth = Math.max(0, width - labelWidth - valueWidth);
  const max = Math.max(1, ...bars.map((bar) => bar.value));
  const height = bars.length * rowHeight;
  const length = (value: number) => (value / max) * plotWidth;
  const middle = (index: number) => index * rowHeight + rowHeight / 2;

  const tipFor = (index: number): Tip | null => {
    const bar = bars[index];
    return bar
      ? { x: labelWidth + length(bar.value) / 2, y: middle(index) - barHeight / 2 - 8, value: describe(bar.value), label: bar.label }
      : null;
  };

  return (
    <div className="chart-plot" ref={ref}>
      {width > 0 ? (
        <svg width={width} height={height} className="chart-svg" role="group">
          <line x1={labelWidth} x2={labelWidth} y1={4} y2={height - 4} className="axis-line" />
          {bars.map((bar, index) => (
            <g key={bar.key}>
              <text x={labelWidth - 10} y={middle(index)} dy="0.32em" textAnchor="end" className="category-label">
                {bar.label}
              </text>
              {bar.value > 0 ? (
                <path
                  d={barPath(labelWidth, middle(index) - barHeight / 2, length(bar.value), barHeight)}
                  className={active === index ? 'mark active' : 'mark'}
                />
              ) : null}
              <text x={labelWidth + length(bar.value) + 8} y={middle(index)} dy="0.32em" className="value-label">
                {formatCount(bar.value)}
              </text>
            </g>
          ))}
          {bars.map((bar, index) => (
            <rect
              key={bar.key}
              x={0}
              y={index * rowHeight}
              width={width}
              height={rowHeight}
              className="hit"
              tabIndex={0}
              aria-label={`${bar.label}: ${describe(bar.value)}`}
              onPointerEnter={() => setActive(index)}
              onPointerLeave={() => setActive(null)}
              onFocus={() => setActive(index)}
              onBlur={() => setActive(null)}
            />
          ))}
        </svg>
      ) : null}
      <Tooltip tip={active === null ? null : tipFor(active)} />
    </div>
  );
}

/* ───────── figures ───────── */

/** A labelled number. `hero` is the one figure the Overview leads with. */
export function StatTile({ label, value, note, hero }: { label: string; value: string; note?: string; hero?: boolean }) {
  return (
    <div className={hero ? 'tile hero' : 'tile'}>
      <div className="tile-label">{label}</div>
      <div className="tile-value">{value}</div>
      {note ? <div className="tile-note">{note}</div> : null}
    </div>
  );
}
