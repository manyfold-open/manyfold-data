/**
 * Records as a data table (desktop) or as list rows (phone). Columns come from the config;
 * each field type has one way to print. Given `onSort`, headers of sortable fields become
 * buttons and the sorted one carries aria-sort.
 */

import { SORTABLE, valueLabel, type DataAppConfig, type FieldDef } from '../../shared/data-app';
import type { QueryState } from '../../shared/query';
import type { PublicRecord } from '../../shared/types';
import { bareLabel, formatShortDate, formatValue } from '../format';
import { shortLabel } from '../model/charts';
import { dateDirection, dateFieldOf } from '../model/filters';
import { Link } from '../router';
import { Amount, Avatar, DataTable, ListRow, Tag, type DataColumn } from '../ui';

export const recordHref = (config: DataAppConfig, record: PublicRecord): string => `/${config.slug}/r/${record.id}`;

export const titleOf = (config: DataAppConfig, record: PublicRecord): string =>
  String(record.data[config.table.columns[0] ?? ''] ?? 'Untitled');

const None = () => (
  <span className="none" aria-label="Not stated">
    —
  </span>
);

/** One field of a record, the way tables print it. */
export function Cell({ config, field, record }: { config: DataAppConfig; field: string; record: PublicRecord }) {
  const def = config.fields[field];
  const value = record.data[field];
  if (value === undefined || value === '' || (Array.isArray(value) && value.length === 0)) {
    // Missing, but the config names another field to show: e.g. "€20 million".
    const other = config.table.fallback?.[field];
    const stand = other ? formatValue(config.fields[other], record.data[other]) : '';
    return stand ? (
      <span className="fallback" title={config.fields[other!]?.label}>
        {stand}
      </span>
    ) : (
      <None />
    );
  }
  if (typeof value === 'number') return <Amount def={def} value={value} />;
  if (def?.type === 'enum' && typeof value === 'string') return <Tag>{shortLabel(valueLabel(def, value))}</Tag>;
  return <>{formatValue(def, value)}</>;
}

const cellClass = (def: FieldDef | undefined, index: number): string | undefined =>
  def?.type === 'date' ? 'date' : def?.type === 'text' || def?.type === 'tags' || def?.type === 'url' ? (index > 1 ? 'text later' : 'text') : undefined;

export function RecordTable({
  config,
  records,
  columns,
  sort,
  onSort,
}: {
  config: DataAppConfig;
  records: readonly PublicRecord[];
  columns: readonly string[];
  sort?: QueryState['sort'];
  onSort?: (field: string) => void;
}) {
  const table: DataColumn<PublicRecord>[] = columns.map((field, index) => {
    const def = config.fields[field];
    const sortable = onSort && def && SORTABLE.includes(def.type);
    const header = bareLabel(def?.label ?? field);
    if (index === 0) {
      return {
        key: field,
        header,
        sorted: sortable ? (sort?.field === field ? (sort.desc ? 'descending' : 'ascending') : null) : undefined,
        onSort: sortable ? () => onSort(field) : undefined,
        render: (record) => {
          const title = titleOf(config, record);
          return (
            <Link href={recordHref(config, record)} className="title-cell" title={title}>
              <Avatar name={title} />
              <span>{title}</span>
            </Link>
          );
        },
      };
    }
    return {
      key: field,
      header,
      numeric: def?.type === 'number',
      className: cellClass(def, index),
      sorted: sortable ? (sort?.field === field ? (sort.desc ? 'descending' : 'ascending') : null) : undefined,
      onSort: sortable ? () => onSort(field) : undefined,
      title: (record) => {
        const value = record.data[field];
        return def?.type === 'text' || def?.type === 'tags' ? (Array.isArray(value) ? value.join(', ') : (value as string | undefined)) : undefined;
      },
      render: (record) => <Cell config={config} field={field} record={record} />,
    };
  });

  return (
    <DataTable
      label={config.title}
      columns={table}
      rows={records}
      rowKey={(record) => record.id}
      rowHref={(record) => recordHref(config, record)}
    />
  );
}

/** Phone rows: title, the first enum value and city under it, the figure and the date on the right. */
export function RecordList({ config, records }: { config: DataAppConfig; records: readonly PublicRecord[] }) {
  const columns = config.table.columns;
  const enumField = columns.find((field) => config.fields[field]?.type === 'enum');
  const tagsField = columns.find((field) => config.fields[field]?.type === 'tags');
  const numberField = columns.find((field) => config.fields[field]?.type === 'number');
  const dateField = dateFieldOf(config);
  const forward = dateField !== null && dateDirection(config, dateField) === 'future';

  return (
    <div className="list">
      {records.map((record) => {
        const enumDef = enumField ? config.fields[enumField] : undefined;
        const enumValue = enumField ? record.data[enumField] : undefined;
        const tags = tagsField ? record.data[tagsField] : undefined;
        const meta = [
          typeof enumValue === 'string' ? shortLabel(valueLabel(enumDef, enumValue)) : '',
          Array.isArray(tags) ? (tags[0] ?? '') : '',
        ]
          .filter(Boolean)
          .join(' · ');
        const date = dateField ? record.data[dateField] : undefined;
        return (
          <ListRow
            key={record.id}
            href={recordHref(config, record)}
            title={titleOf(config, record)}
            meta={meta || undefined}
            value={numberField ? <Cell config={config} field={numberField} record={record} /> : undefined}
            sub={
              typeof date === 'string'
                ? forward
                  ? `${config.fields[dateField!]?.label} ${formatShortDate(date)}`
                  : formatShortDate(date)
                : undefined
            }
          />
        );
      })}
    </div>
  );
}
