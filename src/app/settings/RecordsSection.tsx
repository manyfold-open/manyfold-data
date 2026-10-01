import { useEffect, useState } from 'react';
import { findDataApp } from '../../../data-apps/index';
import type { RecordData } from '../../shared/data-app';
import type { AdminRecord, AdminRecordDetail, RecordStatus } from '../../shared/types';
import { displayUrl, formatValue, safeHref } from '../format';
import { send, useAdmin } from './adminApi';
import { Action, Badge, Field, Notice, plural, When } from './ui';

const STATUSES: RecordStatus[] = ['pending', 'verified', 'rejected', 'merged', 'stale'];

/** Corrections that turn `before` into `after`: changed fields, and null for removed ones. */
function corrections(before: RecordData, after: Record<string, unknown>): Record<string, unknown> {
  const changes: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(after)) {
    if (JSON.stringify(value) !== JSON.stringify(before[field])) changes[field] = value;
  }
  for (const field of Object.keys(before)) if (!(field in after)) changes[field] = null;
  return changes;
}

function Detail({ slug, id, onClose }: { slug: string; id: string; onClose: () => void }) {
  const config = findDataApp(slug)!;
  const { data, error, reload } = useAdmin<AdminRecordDetail>(`/${slug}/records/${id}`);
  const [status, setStatus] = useState<RecordStatus>('verified');
  const [reason, setReason] = useState('');
  const [duplicateOf, setDuplicateOf] = useState('');
  const [draft, setDraft] = useState('');
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (data) setDraft(JSON.stringify(data.record.data, null, 2));
  }, [data]);

  if (!data) return <Notice error={error} />;
  const { record, revisions, tasks, reports } = data;
  const source = safeHref(record.source_url);

  return (
    <section className="panel detail">
      <div className="section-head">
        <h3>
          {record.name} <Badge value={record.status} />
          {record.flagged ? <Badge value="flagged" /> : null}
        </h3>
        <button type="button" className="quiet-button" onClick={onClose}>
          Close
        </button>
      </div>
      <Notice error={error} message={message} />
      <div className="detail-grid">
        <dl className="facts compact">
          {Object.entries(config.fields).map(([field, def]) => (
            <div key={field} className="fact">
              <dt>{def.label}</dt>
              <dd>{formatValue(def, record.data[field]) || <span className="empty">Not stated</span>}</dd>
            </div>
          ))}
          <div className="fact">
            <dt>Submitted by</dt>
            <dd>
              {record.submitted_by.label} <span className="muted small">({record.submitted_by.id})</span>
            </dd>
          </div>
        </dl>
        <div>
          <h4>Source</h4>
          {source ? (
            <a href={source} target="_blank" rel="nofollow ugc noopener noreferrer">
              {displayUrl(record.source_url)} ↗
            </a>
          ) : (
            displayUrl(record.source_url)
          )}
          <blockquote>{record.evidence}</blockquote>
          <h4>Tasks</h4>
          {tasks.length === 0 ? <p className="muted small">None.</p> : null}
          <ul className="plain small">
            {tasks.map((task) => (
              <li key={task.id}>
                {task.kind} <Badge value={task.status} /> <When at={task.created_at} />
              </li>
            ))}
          </ul>
          {reports.length > 0 ? (
            <>
              <h4>Reports</h4>
              <ul className="plain small">
                {reports.map((report) => (
                  <li key={report.id}>
                    <Badge value={report.status} /> {report.reason}
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </div>
      </div>

      <h4>Decide</h4>
      <div className="inline-form">
        <Field label="New status">
          <select value={status} onChange={(event) => setStatus(event.target.value as RecordStatus)}>
            {STATUSES.map((value) => (
              <option key={value} value={value}>
                {value === 'pending' ? 'pending (back to maintainers)' : value}
              </option>
            ))}
          </select>
        </Field>
        {status === 'merged' ? (
          <Field label="Duplicate of (record id)">
            <input type="text" value={duplicateOf} onChange={(event) => setDuplicateOf(event.target.value)} />
          </Field>
        ) : null}
        <Field label="Reason">
          <input type="text" value={reason} onChange={(event) => setReason(event.target.value)} />
        </Field>
        <Action
          label="Apply"
          run={() =>
            send('POST', `/${slug}/records/${id}/decide`, {
              status,
              ...(reason ? { reason } : {}),
              ...(status === 'merged' ? { duplicate_of: duplicateOf } : {}),
            })
          }
          onDone={() => {
            setMessage(`Set to ${status}.`);
            reload();
          }}
        />
      </div>

      <h4>Edit fields</h4>
      <p className="muted small">Change values or delete a line to remove a field. The record keeps its status.</p>
      <textarea className="json-editor" rows={12} value={draft} onChange={(event) => setDraft(event.target.value)} spellCheck={false} />
      <Action
        label="Save fields"
        run={async () => {
          const next = JSON.parse(draft) as Record<string, unknown>;
          const changes = corrections(record.data, next);
          if (Object.keys(changes).length === 0) throw new Error('Nothing changed.');
          return send('PATCH', `/${slug}/records/${id}`, { corrections: changes, ...(reason ? { reason } : {}) });
        }}
        onDone={() => {
          setMessage('Fields saved.');
          reload();
        }}
      />

      <h4>History</h4>
      <ol className="history-list">
        {revisions.map((revision) => (
          <li key={revision.id}>
            <div>
              <strong>{revision.action}</strong> by {revision.actor.label}
              {revision.reason ? <span className="muted"> — {revision.reason}</span> : null}
            </div>
            <When at={revision.created_at} />
          </li>
        ))}
      </ol>
    </section>
  );
}

/** Every record in every status, with a detail view to decide or correct it. */
export default function RecordsSection({
  slug,
  openId,
  onOpen,
}: {
  slug: string;
  openId: string | null;
  onOpen: (id: string | null) => void;
}) {
  const [status, setStatus] = useState('');
  const [q, setQ] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const params = new URLSearchParams({ page: String(page), ...(status ? { status } : {}), ...(search ? { q: search } : {}) });
  const { data, error } = useAdmin<{ total: number; page: number; records: AdminRecord[] }>(`/${slug}/records?${params}`);
  const pages = data ? Math.max(1, Math.ceil(data.total / 50)) : 1;

  return (
    <>
      {openId ? <Detail key={openId} slug={slug} id={openId} onClose={() => onOpen(null)} /> : null}
      <div className="section-head">
        <h2>Records</h2>
        <span className="muted">{data ? plural(data.total, 'record') : ''}</span>
      </div>
      <form
        className="inline-form"
        onSubmit={(event) => {
          event.preventDefault();
          setSearch(q.trim());
          setPage(1);
        }}
      >
        <Field label="Status">
          <select
            value={status}
            onChange={(event) => {
              setStatus(event.target.value);
              setPage(1);
            }}
          >
            <option value="">Any</option>
            {STATUSES.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Search">
          <input type="search" value={q} onChange={(event) => setQ(event.target.value)} placeholder="Name, organizer, URL…" />
        </Field>
        <button type="submit" className="quiet-button">
          Search
        </button>
      </form>
      <Notice error={error} />
      <div className="table-wrap">
        <table className="records">
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Status</th>
              <th scope="col">Submitted by</th>
              <th scope="col">Updated</th>
            </tr>
          </thead>
          <tbody>
            {(data?.records ?? []).map((record) => (
              <tr key={record.id}>
                <td>
                  <button type="button" className="link-button" onClick={() => onOpen(record.id)}>
                    {record.name}
                  </button>
                  {record.flagged ? <Badge value="flagged" /> : null}
                </td>
                <td>
                  <Badge value={record.status} />
                </td>
                <td>{record.submitted_by.label}</td>
                <td>
                  <When at={record.updated_at} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {pages > 1 ? (
        <nav className="pagination" aria-label="Pages">
          <button type="button" disabled={page <= 1} onClick={() => setPage(page - 1)}>
            Previous
          </button>
          <span>
            Page {page} of {pages}
          </span>
          <button type="button" disabled={page >= pages} onClick={() => setPage(page + 1)}>
            Next
          </button>
        </nav>
      ) : null}
    </>
  );
}
