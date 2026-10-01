import { useState } from 'react';
import type { AppOverview, RecordStatus } from '../../shared/types';
import { formatCount } from '../format';
import { send, useAdmin } from './adminApi';
import { Action, Badge, Notice, plural, When } from './ui';

const STATUSES: [RecordStatus, string][] = [
  ['pending', 'Waiting for review'],
  ['verified', 'Verified'],
  ['rejected', 'Rejected'],
  ['merged', 'Merged'],
  ['stale', 'Out of date'],
];

interface CronReport {
  released: number;
  rechecks: number;
  discord: { sent: number; failed: number };
}

const describe = (report: CronReport) =>
  `Released ${plural(report.released, 'expired lease')}, queued ${plural(report.rechecks, 'recheck')}, ` +
  `sent ${plural(report.discord.sent, 'Discord post')}` +
  (report.discord.failed ? `; ${plural(report.discord.failed, 'post')} failed.` : '.');

/** Each data app at a glance: records by status, work waiting, Discord's state. */
export default function OverviewSection() {
  const { data, error, reload } = useAdmin<{ apps: AppOverview[] }>('/overview');
  const [message, setMessage] = useState<string | null>(null);

  return (
    <>
      <div className="section-head">
        <h2>Overview</h2>
        <Action
          label="Run the cron now"
          run={() => send<CronReport>('POST', '/maintenance')}
          onDone={(report) => {
            setMessage(describe(report as CronReport));
            reload();
          }}
        />
      </div>
      <Notice error={error} message={message} />
      {(data?.apps ?? []).map((app) => (
        <section className="panel" key={app.slug}>
          <h3>{app.title}</h3>
          <dl className="stat-row">
            {STATUSES.map(([status, label]) => (
              <div key={status}>
                <dt>{label}</dt>
                <dd>{formatCount(app.counts[status])}</dd>
              </div>
            ))}
            <div>
              <dt>Tasks open or held</dt>
              <dd>{formatCount(app.open_tasks)}</dd>
            </div>
            <div>
              <dt>Review queue</dt>
              <dd>{formatCount(app.review)}</dd>
            </div>
          </dl>
          <p className="muted small">
            Discord <Badge value={app.notify.state} />{' '}
            {app.notify.last_sent_at ? (
              <>
                · last post <When at={app.notify.last_sent_at} />
              </>
            ) : (
              '· no posts yet'
            )}
            {app.notify.waiting > 0 ? ` · ${app.notify.waiting} waiting to be announced` : ''}
          </p>
        </section>
      ))}
    </>
  );
}
