/**
 * The Table's filter column, generated from the config: Smart filter, Popular, one group
 * per enum and tags field with counts from the records response's facets, date pills and
 * amount pills. It edits a QueryState and nothing else, so the desktop column (which writes
 * the URL at once) and the phone sheet (which keeps a draft) share it.
 */

import { useId, useState } from 'react';
import { valueLabel, type DataAppConfig, type FieldDef } from '../../shared/data-app';
import { withFilter, type QueryState } from '../../shared/query';
import type { FacetCount } from '../../shared/types';
import { bareLabel } from '../format';
import {
  amountOf,
  amountPresets,
  dateFieldOf,
  datePresets,
  popularToggle,
  presetOf,
  rangeLabel,
  type PopularItem,
  type Preset,
} from '../model/filters';
import { Button, CheckRow, Icon, RadioPills, ShowAll, Textarea } from '../ui';

const SHOWN = 6;
/** As many tag values as the records response lists. */
const TAGS_MAX = 200;

/** Lowercase, accents removed: "Zürich" is found by "zurich". */
const fold = (text: string): string => text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

function ValueGroup({
  field,
  def,
  state,
  counts,
  onChange,
}: {
  field: string;
  def: FieldDef;
  state: QueryState;
  counts: readonly FacetCount[] | undefined;
  onChange: (state: QueryState) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [find, setFind] = useState('');
  const headingId = useId();
  const filter = state.filters[field];
  const selected = filter?.kind === 'in' ? filter.values : [];
  // Enums keep their config order; tags list what is chosen first, then the most common.
  const all =
    def.type === 'enum'
      ? [...def.values]
      : [...new Set([...selected, ...(counts ?? []).map((count) => count.value)])].slice(0, Math.max(TAGS_MAX, selected.length));
  const matching = find ? all.filter((value) => fold(valueLabel(def, value)).includes(fold(find))) : all;
  const shown = expanded ? matching : all.filter((value, index) => index < SHOWN || selected.includes(value));
  const countOf = (value: string) => (counts ? (counts.find((count) => count.value === value)?.count ?? 0) : null);
  const toggle = (value: string) => {
    const next = selected.includes(value) ? selected.filter((item) => item !== value) : [...selected, value];
    onChange(withFilter(state, field, next.length > 0 ? { kind: 'in', values: next } : null));
  };

  return (
    // A group with a heading rather than fieldset/legend, whose built-in layout pushes the first row down.
    <div className="filter-group" role="group" aria-labelledby={headingId}>
      <h3 id={headingId}>{def.label}</h3>
      {expanded && all.length > 12 ? (
        <input
          type="text"
          className="textarea"
          style={{ minHeight: 0, height: 32, padding: '0 10px', marginBottom: 6 }}
          value={find}
          onChange={(event) => setFind(event.target.value)}
          placeholder={`Find a ${def.label.toLowerCase()}`}
          aria-label={`Find a ${def.label.toLowerCase()}`}
        />
      ) : null}
      {all.length === 0 ? <p className="hint">None yet</p> : null}
      {shown.map((value) => (
        <CheckRow key={value} checked={selected.includes(value)} label={valueLabel(def, value)} count={countOf(value)} onToggle={() => toggle(value)} />
      ))}
      {expanded && find && matching.length === 0 ? <p className="hint">No match</p> : null}
      {all.length > SHOWN ? (
        <ShowAll
          expanded={expanded}
          total={all.length}
          onToggle={() => {
            setExpanded(!expanded);
            setFind('');
          }}
        />
      ) : null}
    </div>
  );
}

function RangeGroup({
  config,
  field,
  title,
  presets,
  state,
  today,
  onChange,
}: {
  config: DataAppConfig;
  field: string;
  title: string;
  presets: Preset[];
  state: QueryState;
  today: string;
  onChange: (state: QueryState) => void;
}) {
  const filter = state.filters[field];
  const preset = presetOf(presets, filter);
  const custom = filter?.kind === 'range' && !preset ? rangeLabel(config, field, filter, today) : null;
  const choices = [
    ...presets.map((item) => ({ value: item.key, label: item.label })),
    ...(custom ? [{ value: 'custom', label: custom }] : []),
  ];
  return (
    <div className="filter-group">
      <h3>{title}</h3>
      <RadioPills
        label={title}
        choices={choices}
        value={custom ? 'custom' : (preset?.key ?? 'any')}
        onChange={(key) => {
          const next = presets.find((item) => item.key === key);
          if (next) onChange(withFilter(state, field, next.filter));
        }}
      />
    </div>
  );
}

export interface SmartFilterState {
  text: string;
  setText: (text: string) => void;
  message: { text: string; miss: boolean } | null;
  apply: () => void;
  placeholder: string;
}

export function FilterPanel({
  config,
  state,
  facets,
  popular,
  smart,
  today,
  onChange,
  inSheet,
  onReset,
}: {
  config: DataAppConfig;
  state: QueryState;
  facets: Record<string, FacetCount[]> | undefined;
  popular: readonly PopularItem[];
  smart: SmartFilterState;
  today: string;
  onChange: (state: QueryState) => void;
  inSheet?: boolean;
  onReset?: () => void;
}) {
  const dateField = dateFieldOf(config);
  const amount = amountOf(config);
  const smartId = inSheet ? 'smart-filter-sheet' : 'smart-filter';
  const active = Object.keys(state.filters).length > 0;
  const popularId = useId();

  return (
    <>
      {inSheet ? null : (
        <div className="filter-head">
          <b>Filters</b>
          {active && onReset ? (
            <button type="button" className="link-button small" onClick={onReset}>
              Reset
            </button>
          ) : null}
        </div>
      )}

      <div className="filter-group">
        <h3>
          <Icon name="spark" size={14} />
          <label htmlFor={smartId}>Smart filter</label>
        </h3>
        <p className="hint" id={`${smartId}-hint`}>
          Describe what you want. It sets the filters below, here in your browser.
        </p>
        <Textarea
          id={smartId}
          rows={3}
          aria-describedby={`${smartId}-hint`}
          placeholder={smart.placeholder}
          value={smart.text}
          maxLength={200}
          onChange={(event) => smart.setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              smart.apply();
            }
          }}
        />
        <Button onClick={smart.apply} disabled={!smart.text.trim()}>
          Apply
        </Button>
        {smart.message ? (
          <p className={smart.message.miss ? 'smart-message miss' : 'smart-message'} role="status">
            <Icon name={smart.message.miss ? 'warn' : 'check'} size={14} />
            <span>{smart.message.text}</span>
          </p>
        ) : null}
      </div>

      {popular.length > 0 ? (
        <div className="filter-group" role="group" aria-labelledby={popularId}>
          <h3 id={popularId}>Popular</h3>
          {popular.map((item) => {
            const { on, next } = popularToggle(state, item);
            const count = item.kind === 'value' ? (facets?.[item.field]?.find((facet) => facet.value === item.value)?.count ?? 0) : null;
            return (
              <CheckRow
                key={`${item.field}:${item.kind === 'value' ? item.value : item.label}`}
                checked={on}
                label={item.label}
                sub={item.sub}
                count={facets ? count : null}
                onToggle={() => onChange(next)}
              />
            );
          })}
        </div>
      ) : null}

      {Object.entries(config.fields).map(([field, def]) =>
        def.type === 'enum' || def.type === 'tags' ? (
          <ValueGroup key={field} field={field} def={def} state={state} counts={facets?.[field]} onChange={onChange} />
        ) : null,
      )}

      {dateField ? (
        <RangeGroup
          config={config}
          field={dateField}
          title={config.fields[dateField]!.label}
          presets={datePresets(config, dateField)}
          state={state}
          today={today}
          onChange={onChange}
        />
      ) : null}

      {amount ? (
        <RangeGroup
          config={config}
          field={amount.field}
          title={bareLabel(config.fields[amount.field]!.label)}
          presets={amountPresets(config)}
          state={state}
          today={today}
          onChange={onChange}
        />
      ) : null}
    </>
  );
}
