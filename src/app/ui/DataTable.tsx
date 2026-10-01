/**
 * The data table: hairline rows, a sticky first column, the rest scrolling sideways. A
 * whole row opens its record; the first cell holds the real link, so keyboards and screen
 * readers get one link per row.
 */

import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { navigate } from '../router';
import { Icon } from './Icon';

export interface DataColumn<R> {
  key: string;
  header: string;
  /** Right-aligned with tabular figures. */
  numeric?: boolean;
  className?: string;
  /** Present when the column sorts: its current direction, or null. */
  sorted?: 'ascending' | 'descending' | null;
  onSort?: () => void;
  render: (row: R) => ReactNode;
  /** The full text, for a cell that truncates. */
  title?: (row: R) => string | undefined;
}

export function DataTable<R>({
  columns,
  rows,
  rowKey,
  rowHref,
  label,
}: {
  columns: readonly DataColumn<R>[];
  rows: readonly R[];
  rowKey: (row: R) => string;
  rowHref?: (row: R) => string;
  label?: string;
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const element = wrap.current;
    if (!element) return;
    const onScroll = () => setScrolled(element.scrollLeft > 0);
    element.addEventListener('scroll', onScroll, { passive: true });
    return () => element.removeEventListener('scroll', onScroll);
  }, []);

  const open = (event: MouseEvent<HTMLTableRowElement>, row: R) => {
    if (!rowHref || (event.target as HTMLElement).closest('a, button')) return;
    if (window.getSelection()?.toString()) return; // the reader is selecting text
    const href = rowHref(row);
    if (event.metaKey || event.ctrlKey) window.open(href, '_blank', 'noopener');
    else navigate(href);
  };

  return (
    <div ref={wrap} className={scrolled ? 'dtable-wrap scrolled' : 'dtable-wrap'}>
      <table className="dtable" aria-label={label}>
        <thead>
          <tr>
            {columns.map((column) => (
              <th
                key={column.key}
                scope="col"
                className={column.numeric ? 'num' : undefined}
                aria-sort={column.sorted ?? undefined}
              >
                {column.onSort ? (
                  <button type="button" className="sort-button" onClick={column.onSort}>
                    {column.header}
                    <Icon name="down" size={12} />
                  </button>
                ) : (
                  column.header
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={rowKey(row)} onClick={(event) => open(event, row)}>
              {columns.map((column) => (
                <td
                  key={column.key}
                  className={[column.numeric ? 'num' : '', column.className ?? ''].join(' ').trim() || undefined}
                  title={column.title?.(row)}
                >
                  {column.render(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
