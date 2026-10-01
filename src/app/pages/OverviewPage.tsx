/**
 * A data app's Overview: the summary tiles, one card per chart in its config, and the
 * first rows of its default Table view.
 */

import { useState } from 'react';
import { valueLabel, type DataAppConfig } from '../../shared/data-app';
import { monthStart, weekStart } from '../../shared/dates';
import { defaultQuery, serializeQuery } from '../../shared/query';
import type { ChartResult, RecordsResponse, StatsResponse } from '../../shared/types';
import { track } from '../analytics';
import { useApi } from '../api';
import { BarChart, ChartCard, ColumnChart, StatTile } from '../components/charts';
import { RecordTable } from '../components/RecordTable';
import {
  capitalize,
  countOf,
  formatCount,
  formatDate,
  formatMonth,
  formatNumber,
  formatShortDate,
  licenseOf,
} from '../format';
import { Link } from '../router';

const PREVIEW_ROWS = 6;

/** The one sentence an owner hands their agent, and the skill it points to. */
function Contribute({ config }: { config: DataAppConfig }) {
  const [copied, setCopied] = useState(false);
  const skillUrl = `${location.origin}/${config.slug}/SKILL.md`;
  const instruction = `Read ${skillUrl} and contribute to ${config.title} as a collector.`;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(instruction);
      track('agent_instruction_copied', { data_app: config.slug });
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard blocked: the sentence is on screen to select by hand.
    }
  };

  return (
    <section className="contribute" aria-labelledby="contribute-heading">
      <h2 id="contribute-heading">Contribute with your agent</h2>
      <p>Any AI agent can collect {config.noun.other} for this dataset. Give yours this instruction:</p>
      <div className="instruction">
        <code>{instruction}</code>
        <button type="button" className="quiet-button" onClick={() => void copy()}>
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <p className="muted small">
        New records stay private until a maintainer checks them against their source.{' '}
        <a href={skillUrl} onClick={() => track('skill_opened', { data_app: config.slug })}>
          Read the skill
        </a>
      </p>
    </section>
  );
}

/** Where readers get each new record as it is verified: the Discord channel, or the feed. */
function Follow({ config, invite }: { config: DataAppConfig; invite: string }) {
  return (
    <section className="contribute follow" aria-labelledby="follow-heading">
      <h2 id="follow-heading">Get new {config.noun.other} as they are verified</h2>
      <p>
        Every {config.noun.one} a maintainer verifies is posted to the {config.title} channel on Discord within minutes.
      </p>
      <p className="follow-actions">
        <a
          className="primary-link"
          href={invite}
          target="_blank"
          rel="noopener noreferrer"
          onClick={() => track('discord_joined', { data_app: config.slug })}
        >
          Join the Discord channel
        </a>
        <span className="muted small">
          or follow the{' '}
          <a href={`/${config.slug}/feed.xml`} onClick={() => track('data_exported', { data_app: config.slug, format: 'rss' })}>
            RSS feed
          </a>
        </span>
      </p>
    </section>
  );
}

function Chart({ config, chart, today }: { config: DataAppConfig; chart: ChartResult; today: string }) {
  const describe = (count: number) => countOf(config, count);
  const nounHeader = capitalize(config.noun.other);

  switch (chart.kind) {
    case 'count':
      return null; // shown as a tile
    case 'over-time': {
      const weekly = chart.bucket === 'week';
      const current = weekly ? weekStart(today) : monthStart(today);
      return (
        <ChartCard
          wide
          title={chart.title}
          table={{
            columns: [weekly ? 'Week starting' : 'Month', nounHeader],
            rows: chart.points.map((point) => [
              weekly ? formatDate(point.start) : formatMonth(point.start),
              formatCount(point.count),
            ]),
          }}
          note={weekly ? 'Weeks start on Monday.' : undefined}
        >
          {chart.points.length > 0 ? (
            <ColumnChart
              labels="max"
              describe={describe}
              columns={chart.points.map((point) => ({
                key: point.start,
                tick: weekly ? formatShortDate(point.start) : formatMonth(point.start),
                label: weekly ? `Week of ${formatDate(point.start)}` : formatMonth(point.start),
                value: point.count,
                current: point.start === current,
              }))}
            />
          ) : (
            <p className="chart-empty">No dates yet.</p>
          )}
        </ChartCard>
      );
    }
    case 'by-category': {
      const def = config.fields[chart.field];
      const bars = chart.bars.map((bar) => ({ key: bar.value, label: valueLabel(def, bar.value), value: bar.count }));
      return (
        <ChartCard
          title={chart.title}
          table={{ columns: [def?.label ?? chart.field, nounHeader], rows: bars.map((bar) => [bar.label, formatCount(bar.value)]) }}
        >
          {bars.length > 0 ? <BarChart bars={bars} describe={describe} /> : <p className="chart-empty">No values yet.</p>}
        </ChartCard>
      );
    }
    case 'histogram': {
      const def = config.fields[chart.field];
      const short = (value: number) => formatNumber(def, value, true);
      const full = (value: number) => formatNumber(def, value);
      const columns = chart.bins.map((bin) => ({
        key: String(bin.from),
        tick: bin.to === null ? `${short(bin.from)}+` : `${short(bin.from)}–${short(bin.to)}`,
        label: bin.to === null ? `${full(bin.from)} or more` : `${full(bin.from)} to under ${full(bin.to)}`,
        value: bin.count,
      }));
      return (
        <ChartCard
          wide
          title={chart.title}
          table={{ columns: [def?.label ?? chart.field, nounHeader], rows: columns.map((column) => [column.label, formatCount(column.value)]) }}
          note={chart.missing > 0 ? `Not stated for ${countOf(config, chart.missing)}.` : undefined}
        >
          <ColumnChart columns={columns} describe={describe} labels="all" />
        </ChartCard>
      );
    }
  }
}

export default function OverviewPage({ config }: { config: DataAppConfig }) {
  const stats = useApi<StatsResponse>(`/api/${config.slug}/stats`);
  const previewParams = serializeQuery(config, defaultQuery(config));
  previewParams.set('limit', String(PREVIEW_ROWS));
  const preview = useApi<RecordsResponse>(`/api/${config.slug}/records?${previewParams}`);

  const data = stats.data;
  const license = licenseOf(config.license);
  const tableHref = `/${config.slug}/table`;

  return (
    <>
      <section className="page-head">
        <h1>{config.title}</h1>
        <p className="lead">{config.description}</p>
        <p className="meta">
          {data ? `${countOf(config, data.tiles.verified)} · ` : ''}
          {data?.tiles.lastUpdated ? `Updated ${formatDate(data.tiles.lastUpdated)} · ` : ''}
          Data under{' '}
          {license.url ? (
            <a href={license.url} rel="license noopener noreferrer" target="_blank">
              {license.name}
            </a>
          ) : (
            license.name
          )}
          {' · '}
          <a href={`/${config.slug}/export.csv`} download onClick={() => track('data_exported', { data_app: config.slug, format: 'csv' })}>
            CSV
          </a>
          {' · '}
          <a href={`/${config.slug}/export.json`} onClick={() => track('data_exported', { data_app: config.slug, format: 'json' })}>
            JSON
          </a>
          {' · '}
          <a href={`/${config.slug}/feed.xml`} onClick={() => track('data_exported', { data_app: config.slug, format: 'rss' })}>
            RSS
          </a>
        </p>
      </section>

      {stats.error ? <p className="notice">Could not load the numbers: {stats.error.message}</p> : null}

      {data ? (
        <>
          <section className="tiles" aria-label="Summary">
            {data.charts.map((chart) =>
              chart.kind === 'count' ? (
                <StatTile key={chart.title} hero label={chart.title} value={formatCount(chart.value)} />
              ) : null,
            )}
            <StatTile label={`Verified ${config.noun.other}`} value={formatCount(data.tiles.verified)} />
            <StatTile label="Added in the last 7 days" value={formatCount(data.tiles.addedLast7Days)} />
            <StatTile label="Waiting for review" value={formatCount(data.tiles.pending)} />
            <StatTile
              label="Last updated"
              value={data.tiles.lastUpdated ? formatDate(data.tiles.lastUpdated) : 'Not yet'}
            />
          </section>

          <section className="charts" aria-label="Charts">
            {data.charts.map((chart) => (
              <Chart key={chart.title} config={config} chart={chart} today={data.today} />
            ))}
          </section>
        </>
      ) : null}

      <section className="preview">
        <div className="section-head">
          <h2>{config.table.previewTitle}</h2>
          <Link href={tableHref}>See all in the table</Link>
        </div>
        {preview.data ? (
          preview.data.records.length > 0 ? (
            <RecordTable
              config={config}
              records={preview.data.records}
              columns={config.table.previewColumns ?? config.table.columns.slice(0, 5)}
            />
          ) : (
            <p className="muted">No {config.noun.other} to show yet.</p>
          )
        ) : null}
      </section>

      <Contribute config={config} />
      {data?.discordInvite ? <Follow config={config} invite={data.discordInvite} /> : null}
    </>
  );
}
