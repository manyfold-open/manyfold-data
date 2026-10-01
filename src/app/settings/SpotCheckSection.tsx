import { useState } from 'react';
import { findDataApp } from '../../../data-apps/index';
import type { SpotCheck } from '../../shared/types';
import { displayUrl, formatValue, safeHref } from '../format';
import { send, useAdmin } from './adminApi';
import { Action, Notice, share } from './ui';

type Item = SpotCheck['items'][number];

function Sample({ slug, item, onMarked }: { slug: string; item: Item; onMarked: () => void }) {
  const config = findDataApp(slug)!;
  const [note, setNote] = useState(item.mark?.note ?? '');
  const mark = (correct: boolean) => send('POST', `/${slug}/spot-check/${item.record.id}`, { correct, ...(note ? { note } : {}) });
  const source = safeHref(item.record.source_url);
  const shown = config.table.columns.slice(1, 5);

  return (
    <li className={item.mark ? `spot-item ${item.mark.correct ? 'right' : 'wrong'}` : 'spot-item'}>
      <div className="spot-head">
        <strong>{item.record.name}</strong>
        {item.mark ? <span className="muted small">{item.mark.correct ? '✓ correct' : '✗ wrong'}</span> : null}
      </div>
      <p className="small">
        {shown
          .map((field) => `${config.fields[field]?.label}: ${formatValue(config.fields[field], item.record.data[field]) || 'not stated'}`)
          .join(' · ')}
      </p>
      <p className="small">
        Source:{' '}
        {source ? (
          <a href={source} target="_blank" rel="nofollow ugc noopener noreferrer">
            {displayUrl(item.record.source_url)} ↗
          </a>
        ) : (
          displayUrl(item.record.source_url)
        )}
      </p>
      <blockquote className="small">{item.record.evidence}</blockquote>
      <div className="inline-form">
        <input type="text" placeholder="Note (what was wrong)" value={note} onChange={(event) => setNote(event.target.value)} aria-label={`Note on ${item.record.name}`} />
        <Action label="Correct" run={() => mark(true)} onDone={onMarked} />
        <Action label="Wrong" tone="danger" run={() => mark(false)} onDone={onMarked} />
      </div>
    </li>
  );
}

/**
 * The weekly accuracy check: open each sampled record's source and say whether the
 * record is right. The sample is the same all week; the share correct is the figure the
 * 30-day target is measured by.
 */
export default function SpotCheckSection({ slug }: { slug: string }) {
  const { data, error, reload } = useAdmin<SpotCheck>(`/${slug}/spot-check`);
  return (
    <>
      <div className="section-head">
        <h2>Spot-check {data ? `· ${data.week}` : ''}</h2>
        {data ? (
          <span className="muted">
            {data.marked} of {data.items.length} checked · {share(data.correct, data.marked)} correct
          </span>
        ) : null}
      </div>
      <Notice error={error} />
      {data && data.items.length === 0 ? <p className="muted">No verified records to check yet.</p> : null}
      <ol className="spot-list">
        {(data?.items ?? []).map((item) => (
          <Sample key={item.record.id} slug={slug} item={item} onMarked={reload} />
        ))}
      </ol>
    </>
  );
}
