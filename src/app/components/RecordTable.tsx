/**
 * Records as table rows. The first column links to the record page. Given `onSort`,
 * headers of sortable fields become buttons and the sorted one carries aria-sort.
 */

import { SORTABLE, type DataAppConfig, type FieldDef } from '../../shared/data-app';
import type { QueryState } from '../../shared/query';
import type { PublicRecord } from '../../shared/types';
import { formatValue } from '../format';
import { Link } from '../router';

const isNumeric = (def: FieldDef | undefined) => def?.type === 'number';
/** Number columns align right; text columns may wrap; the rest stay on one line. */
const cellClass = (def: FieldDef | undefined) => (isNumeric(def) ? 'num' : def?.type === 'text' ? 'wrap' : undefined);

export function RecordTable({
  config,
  records,
  columns,
  sort,
  onSort,
}: {
  config: DataAppConfig;
  records: PublicRecord[];
  columns: readonly string[];
  sort?: QueryState['sort'];
  onSort?: (field: string) => void;
}) {
  return (
    <div className="table-wrap">
      <table className="records">
        <thead>
          <tr>
            {columns.map((field) => {
              const def = config.fields[field];
              const active = sort?.field === field;
              const label = def?.label ?? field;
              return (
                <th
                  key={field}
                  scope="col"
                  className={isNumeric(def) ? 'num' : undefined}
                  aria-sort={active ? (sort?.desc ? 'descending' : 'ascending') : undefined}
                >
                  {onSort && def && SORTABLE.includes(def.type) ? (
                    <button type="button" className="sort-button" onClick={() => onSort(field)}>
                      {label}
                      <span className="sort-mark" aria-hidden="true">
                        {active ? (sort?.desc ? '↓' : '↑') : ''}
                      </span>
                    </button>
                  ) : (
                    label
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {records.map((record) => (
            <tr key={record.id}>
              {columns.map((field, index) => {
                const def = config.fields[field];
                const text = formatValue(def, record.data[field]);
                // Missing, but the config names another field to show: e.g. "€20 million".
                const other = config.table.fallback?.[field];
                const stand = !text && other ? formatValue(config.fields[other], record.data[other]) : '';
                return (
                  <td key={field} className={cellClass(def)}>
                    {index === 0 ? (
                      <Link href={`/${config.slug}/r/${record.id}`}>{text}</Link>
                    ) : text ? (
                      text
                    ) : stand ? (
                      <span className="fallback" title={config.fields[other!]?.label}>
                        {stand}
                      </span>
                    ) : (
                      <span className="empty" aria-label="Not stated">
                        –
                      </span>
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
