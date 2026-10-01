import { useState } from 'react';
import type { ReviewItem } from '../../shared/types';
import { send, useAdmin } from './adminApi';
import { Action, Badge, Notice, When } from './ui';

const KIND: Record<ReviewItem['kind'], string> = {
  unsure: 'Maintainer unsure',
  flagged: 'Flagged at submit',
  report: 'Reader report',
};

function Item({ slug, item, onOpen, onChange }: { slug: string; item: ReviewItem; onOpen: (id: string) => void; onChange: () => void }) {
  const [note, setNote] = useState('');
  const decide = (status: string) =>
    send('POST', `/${slug}/records/${item.record.id}/decide`, { status, ...(note ? { reason: note } : {}) });

  return (
    <li className="review-item">
      <div className="review-head">
        <span className="badge badge-kind">{KIND[item.kind]}</span>
        <button type="button" className="link-button" onClick={() => onOpen(item.record.id)}>
          {item.record.name}
        </button>
        <Badge value={item.record.status} />
        <span className="muted small">
          <When at={item.at} />
        </span>
      </div>
      <p className="review-reason">{item.reason}</p>
      <div className="review-actions">
        <input
          type="text"
          placeholder="Reason or note (needed to reject)"
          aria-label={`Reason for ${item.record.name}`}
          value={note}
          onChange={(event) => setNote(event.target.value)}
        />
        <Action label="Verify" run={() => decide('verified')} onDone={onChange} />
        <Action label="Reject" tone="danger" run={() => decide('rejected')} onDone={onChange} />
        <Action label="Back to maintainers" run={() => decide('pending')} onDone={onChange} />
        {item.report_id !== null ? (
          <Action label="Close report" run={() => send('POST', `/reports/${item.report_id}/resolve`)} onDone={onChange} />
        ) : null}
      </div>
    </li>
  );
}

/** Everything that waits for a person: unsure verdicts, flagged records, reader reports. */
export default function ReviewSection({ slug, onOpen }: { slug: string; onOpen: (id: string) => void }) {
  const { data, error, reload } = useAdmin<{ items: ReviewItem[] }>(`/${slug}/review`);
  return (
    <>
      <div className="section-head">
        <h2>Review queue</h2>
        <span className="muted">{data ? `${data.items.length} waiting` : ''}</span>
      </div>
      <Notice error={error} />
      {data && data.items.length === 0 ? <p className="muted">Nothing waits for review.</p> : null}
      <ul className="review-list">
        {(data?.items ?? []).map((item) => (
          <Item
            key={`${item.kind}-${item.task_id ?? item.report_id ?? item.record.id}`}
            slug={slug}
            item={item}
            onOpen={onOpen}
            onChange={reload}
          />
        ))}
      </ul>
    </>
  );
}
