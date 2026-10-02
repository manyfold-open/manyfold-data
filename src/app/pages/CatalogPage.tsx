import { useState } from 'react';
import { dataApps } from '../../../data-apps/index';
import type { DataAppConfig } from '../../shared/data-app';
import type { AppSummary, AppsResponse, StatsResponse } from '../../shared/types';
import { useApi } from '../api';
import { RequestSheet } from '../components/RequestSheet';
import { formatCount, formatDate } from '../format';
import { Link } from '../router';
import { Icon, Skeleton, usePending } from '../ui';

/** A line through the over-time chart's counts: how the data app has grown lately. */
function Spark({ values, width = 120, height = 44 }: { values: number[]; width?: number; height?: number }) {
  if (values.length < 2) return null;
  const max = Math.max(1, ...values);
  const d = values
    .map((value, index) => `${index ? 'L' : 'M'}${((index * width) / (values.length - 1)).toFixed(1)},${(height - 3 - (value / max) * (height - 6)).toFixed(1)}`)
    .join(' ');
  return (
    <svg className="spark" width={width} height={height} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" aria-hidden="true">
      <path d={d} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

function Card({ config, summary }: { config: DataAppConfig; summary: AppSummary | undefined }) {
  const stats = useApi<StatsResponse>(`/api/${config.slug}/stats`);
  const overTime = stats.data?.charts.find((chart) => chart.kind === 'over-time');
  return (
    <li>
      <Link href={`/${config.slug}`} className="catalog-card">
        <h2>{config.title}</h2>
        <p>{config.description}</p>
        <p className="foot">
          {summary ? (
            <>
              <b>{formatCount(summary.verified)}</b> {summary.verified === 1 ? config.noun.one : config.noun.other}
              {summary.lastUpdated ? ` · updated ${formatDate(summary.lastUpdated)}` : ''}
            </>
          ) : (
            <Skeleton width="60%" height={14} style={{ marginTop: 3 }} />
          )}
        </p>
        <span className="spark">
          {overTime?.kind === 'over-time' ? <Spark values={overTime.points.map((point) => point.count)} /> : <span style={{ display: 'block', width: 120, height: 44 }} />}
        </span>
      </Link>
    </li>
  );
}

/** The last tile: how a reader asks for data we do not track yet. A button holds no headings. */
function RequestCard({ onOpen }: { onOpen: () => void }) {
  return (
    <li>
      <button type="button" className="catalog-card catalog-request" aria-haspopup="dialog" onClick={onOpen}>
        <span className="request-title">
          <Icon name="plus" size={18} />
          Request a data app
        </span>
        <span className="request-text">Tell us what you would like AI agents to track next.</span>
      </button>
    </li>
  );
}

/** The front page: every data app, with how much it holds and when it last changed, and a way to ask for another. */
export default function CatalogPage() {
  const { data, error } = useApi<AppsResponse>('/api/apps');
  const pending = usePending(!data && !error);
  const [requesting, setRequesting] = useState(false);

  return (
    <div className={pending.visible ? 'sk-on' : undefined}>
      <section className="page-head">
        <h1>Data apps</h1>
        <p className="desc">Open datasets that AI agents collect and people check. Every record links to its source.</p>
      </section>
      {error ? <p className="notice">Could not load the data apps: {error.message}</p> : null}
      <ul className="catalog">
        {dataApps.map((config) => (
          <Card key={config.slug} config={config} summary={data?.apps.find((app) => app.slug === config.slug)} />
        ))}
        <RequestCard onOpen={() => setRequesting(true)} />
      </ul>
      <RequestSheet open={requesting} onClose={() => setRequesting(false)} />
    </div>
  );
}
