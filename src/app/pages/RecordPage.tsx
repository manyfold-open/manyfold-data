/**
 * One record: its fields, the page and quote it was checked against, and its history.
 * A merged record forwards to the record it was merged into.
 */

import { useEffect, useState, type FormEvent } from 'react';
import type { DataAppConfig } from '../../shared/data-app';
import type { MergedResponse, RecordResponse } from '../../shared/types';
import { track } from '../analytics';
import { postJson, useApi } from '../api';
import { displayUrl, formatDate, formatTime, formatValue, safeHref } from '../format';
import { Link, navigate } from '../router';
import NotFound from './NotFound';

const ACTIONS: Record<string, string> = {
  submit: 'Submitted',
  verify: 'Verified',
  reject: 'Rejected',
  merge: 'Merged',
  correct: 'Corrected',
  stale: 'Marked out of date',
  admin_edit: 'Edited',
  revert: 'Reverted',
};

// Links in records come from contributors: never pass them ranking or a referrer.
const EXTERNAL = { target: '_blank', rel: 'nofollow ugc noopener noreferrer' } as const;

/** A reader tells the admin what is wrong with a record; it lands in the review queue. */
function Report({ config, id }: { config: DataAppConfig; id: string }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [state, setState] = useState<'writing' | 'sending' | 'sent'>('writing');
  const [error, setError] = useState('');

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setState('sending');
    setError('');
    try {
      await postJson(`/api/${config.slug}/records/${encodeURIComponent(id)}/report`, { reason: reason.trim() });
      track('record_reported', { data_app: config.slug });
      setState('sent');
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not send the report.');
      setState('writing');
    }
  };

  if (state === 'sent') return <p className="notice good">Thank you. The admin will check it against the source.</p>;
  if (!open) {
    return (
      <button type="button" className="link-button small" onClick={() => setOpen(true)}>
        Something wrong? Report it
      </button>
    );
  }
  return (
    <form className="report-form" onSubmit={(event) => void submit(event)}>
      <label className="field">
        <span>What is wrong with this {config.noun.one}?</span>
        <textarea
          rows={3}
          maxLength={500}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          placeholder="The deadline moved to 12 November."
          autoFocus
        />
      </label>
      {error ? (
        <p className="notice" role="alert">
          {error}
        </p>
      ) : null}
      <div className="inline-form">
        <button type="submit" className="quiet-button" disabled={state === 'sending' || reason.trim().length < 3}>
          {state === 'sending' ? 'Sending…' : 'Send report'}
        </button>
        <button type="button" className="quiet-button" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </form>
  );
}

export default function RecordPage({ config, id }: { config: DataAppConfig; id: string }) {
  const { data, error } = useApi<RecordResponse | MergedResponse>(
    `/api/${config.slug}/records/${encodeURIComponent(id)}`,
  );
  const found = data && 'record' in data ? data : null;
  const titleField = config.table.columns[0] ?? 'name';
  const name = found ? String(found.record.data[titleField] ?? 'Untitled') : '';

  useEffect(() => {
    if (data && 'merged_into' in data) navigate(`/${config.slug}/r/${data.merged_into}`, { replace: true });
  }, [config.slug, data]);

  useEffect(() => {
    if (name) document.title = `${name} · ${config.title} · Manyfold Data`;
  }, [config.title, name]);

  if (error?.status === 404) return <NotFound message="This record does not exist, or it is not public." />;
  if (error) return <p className="notice">Could not load the record: {error.message}</p>;
  if (!found) return <p className="muted">Loading</p>;

  const { record, revisions } = found;

  return (
    <article className="record">
      <nav className="crumbs" aria-label="Breadcrumb">
        <Link href={`/${config.slug}`}>{config.title}</Link>
        <span aria-hidden="true"> / </span>
        <Link href={`/${config.slug}/table`}>Table</Link>
      </nav>
      <h1>{name}</h1>
      {record.status === 'verified' ? (
        <p className="status verified">
          <span aria-hidden="true">✓ </span>
          Verified{record.verified_at ? ` on ${formatDate(record.verified_at)}` : ''}
        </p>
      ) : (
        <p className="status stale">
          <span aria-hidden="true">! </span>
          May be out of date: a recheck found the source no longer agrees
        </p>
      )}

      <div className="record-grid">
        <dl className="facts">
          {Object.entries(config.fields)
            .filter(([field]) => field !== titleField)
            .map(([field, def]) => {
              const value = record.data[field];
              const text = formatValue(def, value);
              return (
                <div key={field} className="fact">
                  <dt>{def.label}</dt>
                  <dd>
                    {def.type === 'url' && typeof value === 'string' && safeHref(value) ? (
                      <a href={safeHref(value)!} {...EXTERNAL}>
                        {text} <span aria-hidden="true">↗</span>
                      </a>
                    ) : text ? (
                      text
                    ) : (
                      <span className="empty">Not stated</span>
                    )}
                  </dd>
                </div>
              );
            })}
        </dl>

        <aside className="source" aria-labelledby="source-heading">
          <h2 id="source-heading">Source</h2>
          {safeHref(record.source_url) ? (
            <a href={safeHref(record.source_url)!} className="source-link" {...EXTERNAL}>
              {displayUrl(record.source_url)} <span aria-hidden="true">↗</span>
            </a>
          ) : (
            <p className="source-link">{displayUrl(record.source_url)}</p>
          )}
          <blockquote>{record.evidence}</blockquote>
          <p className="muted small">Read on {formatTime(record.observed_at)}</p>
          <Report config={config} id={record.id} />
        </aside>
      </div>

      <section className="history" aria-labelledby="history-heading">
        <h2 id="history-heading">History</h2>
        <ol>
          {revisions.map((revision, index) => (
            <li key={`${revision.created_at}-${index}`}>
              <div>
                <strong>{ACTIONS[revision.action] ?? revision.action}</strong> by {revision.actor}
              </div>
              <time dateTime={revision.created_at}>{formatTime(revision.created_at)}</time>
              {revision.reason ? <p className="small">{revision.reason}</p> : null}
            </li>
          ))}
        </ol>
      </section>
    </article>
  );
}
