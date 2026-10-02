/**
 * A data app's Overview: the stat strip, one chart per entry in the config's `charts`, the
 * first rows of the default Table view, and how to contribute. Everything is computed from the
 * data app's dataset (src/app/dataset.ts); nothing here knows which data app it is showing.
 */

import { useMemo } from 'react';
import { valueLabel, type ChartDef, type DataAppConfig } from '../../shared/data-app';
import { listFrom, statsFrom } from '../../shared/engine';
import { defaultQuery } from '../../shared/query';
import type { ChartResult, StatsResponse } from '../../shared/types';
import { track } from '../analytics';
import { useDataset } from '../dataset';
import { ChartFrame, Columns, Coverage, RankedBars, ShareBar, type CategoryItem } from '../components/charts';
import { ContributeStrip, FollowStrip } from '../components/Contribute';
import { RecordList, RecordTable } from '../components/RecordTable';
import { countOf, formatCount, formatDate, formatShortDate, formatTime, licenseOf, nounTitle } from '../format';
import { useIsPhone } from '../hooks';
import { tableHrefFor } from '../memory';
import {
  columnsModel,
  coverageText,
  histogramModel,
  RANKED_TOP,
  takeaway,
  treatmentOf,
} from '../model/charts';
import { binHref, bucketHref, valueHref } from '../model/drill';
import { Link } from '../router';
import { Icon, Menu, Skeleton, usePending } from '../ui';

const PREVIEW_ROWS = 6;

function Stat({ label, value, note, up }: { label: string; value: string; note: string; up?: boolean }) {
  return (
    <div className="stat">
      <span className="label">{label}</span>
      <span className="value">{value}</span>
      <span className={up ? 'note up' : 'note'}>{note}</span>
    </div>
  );
}

const pct = (part: number, whole: number) => `${whole > 0 ? Math.round((part / whole) * 100) : 0}%`;

function Chart({ config, chart, index, stats }: { config: DataAppConfig; chart: ChartResult; index: number; stats: StatsResponse }) {
  const noun = (count: number) => countOf(config, count);
  const nounHeader = nounTitle(config);
  const id = `${config.slug}:${index}`;
  const parts = takeaway(config, chart, stats);

  switch (chart.kind) {
    case 'count':
      return null; // a tile in the stat strip
    case 'over-time': {
      const model = columnsModel(config, chart, stats.today);
      const weekly = chart.bucket === 'week';
      const when = (start: string) => (weekly ? `Week of ${formatShortDate(start)}` : formatDate(start).replace(/ \d+,/, ''));
      return (
        <ChartFrame
          id={id}
          full
          title={chart.title}
          takeaway={parts}
          head={[weekly ? 'Week starting' : 'Month', nounHeader]}
          rows={chart.points.map((point) => ({
            label: weekly ? formatDate(point.start) : when(point.start),
            value: point.count,
            href: bucketHref(config, chart.field, point.start, chart.bucket),
          }))}
        >
          {() =>
            chart.points.length > 0 ? (
              <Columns
                top={model.top}
                todayAt={model.todayAt}
                labels={model.labels}
                items={model.columns.map((column) => ({
                  key: column.start,
                  value: column.count,
                  now: column.now,
                  later: column.later,
                  href: bucketHref(config, chart.field, column.start, chart.bucket),
                  tip: `${when(column.start)} · ${noun(column.count)}${column.now ? ` · this ${chart.bucket}` : ''}`,
                }))}
              />
            ) : (
              <p className="chart-note">No dates yet.</p>
            )
          }
        </ChartFrame>
      );
    }
    case 'by-category': {
      const def = config.fields[chart.field];
      const share = treatmentOf(config, chart) === 'share';
      const whole = def?.type === 'tags' ? stats.tiles.verified : chart.bars.reduce((sum, bar) => sum + bar.count, 0);
      const items: CategoryItem[] = chart.bars.map((bar) => ({
        key: bar.value,
        label: valueLabel(def, bar.value),
        count: bar.count,
        share: pct(bar.count, whole),
        href: valueHref(config, chart.field, bar.value),
      }));
      return (
        <ChartFrame
          id={id}
          title={chart.title}
          takeaway={parts}
          head={[def?.label ?? chart.field, nounHeader]}
          rows={items.map((item) => ({ label: item.label, value: item.count, href: item.href }))}
        >
          {() =>
            items.length === 0 ? (
              <p className="chart-note">No values yet.</p>
            ) : share ? (
              <ShareBar items={items} noun={noun} />
            ) : (
              <RankedBars items={items.filter((item) => item.count > 0)} top={RANKED_TOP} noun={noun} />
            )
          }
        </ChartFrame>
      );
    }
    case 'histogram': {
      const def = config.fields[chart.field];
      const model = histogramModel(config, chart);
      return (
        <ChartFrame
          id={id}
          title={chart.title}
          takeaway={parts}
          head={[def?.label ?? chart.field, nounHeader]}
          rows={[
            ...model.bins.map((bin) => ({ label: bin.label, value: bin.count, href: binHref(config, chart.field, bin) })),
            { label: 'Not stated', value: chart.missing },
          ]}
        >
          {() => (
            <>
              {model.lowCoverage ? <Coverage text={coverageText(config, chart)} share={model.coverage} /> : null}
              <Columns
                top={model.top}
                ticks={model.bins.map((bin) => bin.tick)}
                items={model.bins.map((bin) => ({
                  key: String(bin.from),
                  value: bin.count,
                  href: binHref(config, chart.field, bin),
                  tip: `${bin.label} · ${noun(bin.count)}`,
                }))}
              />
              <p className="chart-note">Select a bar to see those {config.noun.other}.</p>
            </>
          )}
        </ChartFrame>
      );
    }
  }
}

/** Rows a chart's body needs before its data is in, so the page does not move when it lands. */
function chartSkeletonHeight(config: DataAppConfig, chart: ChartDef, phone: boolean): number {
  const treatment = treatmentOf(config, chart);
  if (treatment === 'columns') return (phone ? 150 : 180) + 22;
  if (treatment === 'histogram') return (phone ? 150 : 180) + 23 + 29;
  const def = 'field' in chart ? config.fields[chart.field] : undefined;
  const values = def?.type === 'enum' ? def.values.length : RANKED_TOP + 1;
  if (treatment === 'share') return 28 + values * 37;
  return Math.min(values, RANKED_TOP) * 35 + (values > RANKED_TOP ? 25 : 0);
}

function OverviewSkeleton({ config, phone }: { config: DataAppConfig; phone: boolean }) {
  const charts = config.charts.filter((chart) => chart.kind !== 'count');
  const tiles = config.charts.filter((chart) => chart.kind === 'count').length + 3;
  const frame = (chart: ChartDef, index: number) => (
    <section key={index} className={chart.kind === 'over-time' ? 'chart full' : 'chart'} aria-hidden="true">
      <div className="chart-head">
        <h2>{chart.title}</h2>
        <Skeleton width={104} height={28} style={{ borderRadius: 8 }} />
      </div>
      <div className="takeaway">
        <Skeleton width="45%" height={13} style={{ marginTop: 3 }} />
      </div>
      <Skeleton height={chartSkeletonHeight(config, chart, phone)} />
    </section>
  );
  return (
    <>
      <div className="stats" aria-hidden="true">
        {Array.from({ length: tiles }, (_, index) => (
          <div key={index} className="stat">
            <Skeleton width="60%" height={13} style={{ marginTop: 3 }} />
            <Skeleton width="40%" height={20} style={{ marginTop: 4 }} />
            <Skeleton width="50%" height={11} style={{ marginTop: 4 }} />
          </div>
        ))}
      </div>
      {charts.filter((chart) => chart.kind === 'over-time').map(frame)}
      <div className="chart-grid">{charts.filter((chart) => chart.kind !== 'over-time').map(frame)}</div>
    </>
  );
}

export default function OverviewPage({ config }: { config: DataAppConfig }) {
  const phone = useIsPhone();
  const dataset = useDataset(config.slug);
  const stats = {
    data: useMemo(() => (dataset.data ? statsFrom(config, dataset.data, new Date()) : null), [config, dataset.data]),
    error: dataset.error,
  };
  const preview = {
    data: useMemo(
      () => (dataset.data ? listFrom(config, dataset.data, defaultQuery(config), PREVIEW_ROWS, { facets: false }) : null),
      [config, dataset.data],
    ),
    error: dataset.error,
  };
  const statsPending = usePending(!stats.data && !stats.error);
  const previewPending = usePending(!preview.data && !preview.error);

  const data = statsPending.pending ? null : stats.data;
  const license = licenseOf(config.license);
  const exportItems = [
    { key: 'csv', label: 'CSV', note: 'spreadsheet', href: `/${config.slug}/export.csv`, download: true, onSelect: () => track('data_exported', { data_app: config.slug, format: 'csv' }) },
    { key: 'json', label: 'JSON', note: 'every field', href: `/${config.slug}/export.json`, onSelect: () => track('data_exported', { data_app: config.slug, format: 'json' }) },
    { key: 'rss', label: 'RSS', note: 'new records', href: `/${config.slug}/feed.xml`, onSelect: () => track('data_exported', { data_app: config.slug, format: 'rss' }) },
  ];
  const previewColumns = config.table.previewColumns ?? config.table.columns.slice(0, 5);
  const previewRows = preview.data?.records.slice(0, phone ? 5 : PREVIEW_ROWS) ?? [];

  return (
    <>
      <section className="page-head">
        <h1>{config.title}</h1>
        <p className="desc">{config.description}</p>
        <div className="meta">
          {stats.data ? <span>{countOf(config, stats.data.tiles.verified)}</span> : null}
          {stats.data?.tiles.lastUpdated ? <span>Updated {formatDate(stats.data.tiles.lastUpdated)}</span> : null}
          <span>
            Data under{' '}
            {license.url ? (
              <a href={license.url} rel="license noopener noreferrer" target="_blank">
                {license.name}
              </a>
            ) : (
              license.name
            )}
          </span>
          <Menu label="Download" icon="download" items={exportItems} />
        </div>
      </section>

      {stats.error ? <p className="notice">Could not load the numbers: {stats.error.message}</p> : null}

      {data ? (
        <>
          <section className="stats" aria-label="Summary">
            {data.charts.map((chart) =>
              chart.kind === 'count' ? (
                <Stat
                  key={chart.title}
                  label={chart.title}
                  value={formatCount(chart.value)}
                  note={`${pct(chart.value, data.tiles.verified)} of all ${config.noun.other}`}
                />
              ) : null,
            )}
            <Stat
              label={`Verified ${config.noun.other}`}
              value={formatCount(data.tiles.verified)}
              note={`+${formatCount(data.tiles.addedLast7Days)} in 7 days`}
              up={data.tiles.addedLast7Days > 0}
            />
            <Stat label="Waiting for review" value={formatCount(data.tiles.pending)} note="not public yet" />
            <Stat
              label="Last updated"
              value={data.tiles.lastUpdated ? formatShortDate(data.tiles.lastUpdated) : 'Not yet'}
              note={data.tiles.lastUpdated ? formatTime(data.tiles.lastUpdated).replace(/^.*, (\d\d:\d\d UTC)$/, '$1') : ''}
            />
          </section>

          {data.charts.map((chart, index) =>
            chart.kind === 'over-time' ? <Chart key={chart.title} config={config} chart={chart} index={index} stats={data} /> : null,
          )}
          <div className="chart-grid">
            {data.charts.map((chart, index) =>
              chart.kind === 'by-category' || chart.kind === 'histogram' ? (
                <Chart key={chart.title} config={config} chart={chart} index={index} stats={data} />
              ) : null,
            )}
          </div>
        </>
      ) : stats.error ? null : (
        <div className={statsPending.visible ? 'sk-on' : undefined}>
          <OverviewSkeleton config={config} phone={phone} />
        </div>
      )}

      <section className="section" aria-labelledby="preview-heading">
        <div className="section-head">
          <h2 id="preview-heading">
            <Link href={tableHrefFor(config.slug)}>
              {config.table.previewTitle}
              <Icon name="right" size={18} />
            </Link>
          </h2>
        </div>
        {preview.data && !previewPending.pending ? (
          previewRows.length > 0 ? (
            phone ? (
              <RecordList config={config} records={previewRows} />
            ) : (
              <RecordTable config={config} records={previewRows} columns={previewColumns} />
            )
          ) : (
            <p className="muted">No {config.noun.other} to show yet.</p>
          )
        ) : preview.error ? (
          <p className="notice">{preview.error.message}</p>
        ) : (
          <div className={previewPending.visible ? 'sk-on' : undefined} aria-hidden="true">
            {Array.from({ length: phone ? 5 : PREVIEW_ROWS + 1 }, (_, index) => (
              <Skeleton key={index} height={phone ? 44 : index === 0 ? 24 : 36} style={{ margin: phone ? '12px 0' : '12px 0' }} />
            ))}
          </div>
        )}
      </section>

      <ContributeStrip config={config} />
      {stats.data?.discordInvite ? <FollowStrip config={config} invite={stats.data.discordInvite} /> : null}
    </>
  );
}
