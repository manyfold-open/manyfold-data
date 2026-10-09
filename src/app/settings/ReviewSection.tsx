import { useState } from 'react';
import type { Precedent, ReviewItem, UnsureType } from '../../shared/types';
import { send, useAdmin } from './adminApi';
import { Action, Badge, Notice, plural, When } from './ui';

const KIND: Record<ReviewItem['kind'], string> = {
  unsure: 'Maintainer unsure',
  flagged: 'Flagged at submit',
  report: 'Reader report',
};

/** Why a maintainer could not decide, as the admin reads it. */
const UNSURE: Record<UnsureType, string> = {
  cannot_open: 'Could not open its page',
  duplicate_pending: 'Duplicate of a waiting record',
  conflict: 'Sources disagree',
  policy: 'Rules do not say',
};

function Item({ slug, item, onOpen, onChange }: { slug: string; item: ReviewItem; onOpen: (id: string) => void; onChange: () => void }) {
  const [note, setNote] = useState('');
  const [more, setMore] = useState(false);
  const [source, setSource] = useState('');
  const [quote, setQuote] = useState('');
  const [precedent, setPrecedent] = useState('');
  // The admin's own passage becomes a verified record's source; a precedent states the rule this decision follows.
  const passage = source.trim() || quote.trim() ? { source_url: source.trim(), evidence: quote.trim() } : {};
  const decide = (status: string) =>
    send('POST', `/${slug}/records/${item.record.id}/decide`, {
      status,
      ...(note ? { reason: note } : {}),
      ...passage,
      ...(precedent.trim() ? { precedent: precedent.trim() } : {}),
    });

  return (
    <li className="review-item">
      <div className="review-head">
        <span className="badge badge-kind">{KIND[item.kind]}</span>
        {item.unsure_type ? <span className="badge">{UNSURE[item.unsure_type]}</span> : null}
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
        <button type="button" className="link-button small" onClick={() => setMore(!more)}>
          {more ? 'Fewer fields' : 'Your passage, precedent'}
        </button>
      </div>
      {more ? (
        <div className="review-actions review-more">
          <input
            type="text"
            placeholder="Page your decision rests on (https://…)"
            aria-label={`Source for ${item.record.name}`}
            value={source}
            onChange={(event) => setSource(event.target.value)}
          />
          <input
            type="text"
            placeholder="Passage copied from it, word for word"
            aria-label={`Passage for ${item.record.name}`}
            value={quote}
            maxLength={300}
            onChange={(event) => setQuote(event.target.value)}
          />
          <input
            type="text"
            placeholder="Precedent: the rule this decision follows, for the rules to learn"
            aria-label={`Precedent for ${item.record.name}`}
            value={precedent}
            maxLength={300}
            onChange={(event) => setPrecedent(event.target.value)}
          />
        </div>
      ) : null}
    </li>
  );
}

/** Decisions that state a rule, until the rule is written into the data app's config; then they are marked adopted. */
function Precedents({ slug }: { slug: string }) {
  const { data, reload } = useAdmin<{ precedents: Precedent[] }>('/precedents');
  const mine = (data?.precedents ?? []).filter((precedent) => precedent.app_slug === slug);
  if (mine.length === 0) return null;
  return (
    <>
      <div className="section-head">
        <h3>Precedents not yet in the rules</h3>
        <span className="muted">{plural(mine.length, 'precedent')}</span>
      </div>
      <ul className="review-list">
        {mine.map((precedent) => (
          <li key={precedent.id} className="review-item">
            <p className="review-reason">{precedent.rule}</p>
            <p className="muted small">
              {precedent.decision} · <code>{precedent.record_id}</code> · <When at={precedent.created_at} />
            </p>
            <Action label="Written into the rules" run={() => send('POST', `/precedents/${precedent.id}/adopt`)} onDone={reload} />
          </li>
        ))}
      </ul>
    </>
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
      <p className="muted small">
        Only what maintainers could not settle comes here: a page no maintainer with a browser could open, sources two maintainers found in
        conflict, or a question the rules do not answer. When a decision states a rule, add it as a precedent, so the rules learn it.
      </p>
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
      <Precedents slug={slug} />
    </>
  );
}
