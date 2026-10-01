import { Fragment, useState } from 'react';
import { dataApps } from '../../../data-apps/index';
import type { AdminToken, IssuedToken, RevertReport } from '../../shared/types';
import { formatCount, formatTime } from '../format';
import { send, useAdmin } from './adminApi';
import { DateField, Select } from '../ui';
import { Action, Badge, Field, Notice, plural, share, When } from './ui';

/** The token's name, with an inline rename: the new name shows in every history at once. */
function Name({ token, onDone }: { token: AdminToken; onDone: (message: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [label, setLabel] = useState(token.label);
  if (!editing) {
    return (
      <span className="name-cell">
        {token.label}{' '}
        <button type="button" className="link-button small" onClick={() => setEditing(true)} aria-label={`Rename ${token.label}`}>
          Rename
        </button>
      </span>
    );
  }
  return (
    <form className="rename" onSubmit={(event) => event.preventDefault()}>
      <input
        type="text"
        value={label}
        onChange={(event) => setLabel(event.target.value)}
        onFocus={(event) => event.target.select()}
        maxLength={80}
        aria-label="New name"
        autoFocus
      />
      <Action
        label="Save"
        run={() => send('PATCH', `/tokens/${token.id}`, { label })}
        onDone={() => {
          setEditing(false);
          onDone(`Renamed ${token.label} to ${label.trim()}.`);
        }}
      />
      <button
        type="button"
        className="quiet-button"
        onClick={() => {
          setLabel(token.label);
          setEditing(false);
        }}
      >
        Cancel
      </button>
    </form>
  );
}

const UNDO_WINDOWS = [
  { value: '1', label: 'Last hour' },
  { value: '24', label: 'Last 24 hours' },
  { value: '168', label: 'Last 7 days' },
  { value: '720', label: 'Last 30 days' },
] as const;

/** Undo a token's changes over a window the admin picks (default: the last 24 hours). */
function Undo({ token, onDone }: { token: AdminToken; onDone: (message: string) => void }) {
  const [hours, setHours] = useState<(typeof UNDO_WINDOWS)[number]['value']>('24');
  const since = () => new Date(Date.now() - Number(hours) * 3_600_000).toISOString();
  return (
    <span className="undo">
      <Select label={`Undo ${token.label}'s changes from`} value={hours} options={UNDO_WINDOWS} onChange={setHours} />
      <Action
        label="Undo"
        tone="danger"
        confirm={`Undo every change ${token.label} made since ${formatTime(since())}?`}
        run={() => send<RevertReport>('POST', `/tokens/${token.id}/revert`, { since: since() })}
        onDone={(result) => {
          const report = result as RevertReport;
          onDone(
            `Undid changes to ${plural(report.reverted, 'record')} by ${token.label}.` +
              (report.skipped.length
                ? ` Left ${plural(report.skipped.length, 'record')} for you to settle: ${report.skipped.map((skip) => `${skip.record_id} (${skip.reason})`).join('; ')}.`
                : ''),
          );
        }}
      />
    </span>
  );
}

function StatusActions({ token, onDone }: { token: AdminToken; onDone: (message: string) => void }) {
  const set = (status: string) => send('PATCH', `/tokens/${token.id}`, { status });
  if (token.status === 'revoked') return null;
  return (
    <>
      {token.status === 'active' ? (
        <Action label="Suspend" run={() => set('suspended')} onDone={() => onDone(`Suspended ${token.label}.`)} />
      ) : (
        <Action label="Activate" run={() => set('active')} onDone={() => onDone(`Activated ${token.label}.`)} />
      )}
      {token.role === 'collector' ? (
        <Action
          label="Ban"
          tone="danger"
          confirm={`Ban ${token.label}? Its token is revoked and its records waiting for review are rejected.`}
          run={() => send<{ rejected: number }>('POST', `/tokens/${token.id}/ban`)}
          onDone={(result) =>
            onDone(
              `Banned ${token.label}; rejected ${plural((result as { rejected: number }).rejected, 'waiting record')}.`,
            )
          }
        />
      ) : (
        <Action
          label="Revoke"
          tone="danger"
          confirm={`Revoke ${token.label}? It stops working at once.`}
          run={() => set('revoked')}
          onDone={() => onDone(`Revoked ${token.label}.`)}
        />
      )}
      <Action
        label="Recheck its records"
        run={() => send<{ queued: number }>('POST', `/tokens/${token.id}/recheck`)}
        onDone={(result) => onDone(`Queued ${plural((result as { queued: number }).queued, 'recheck')}.`)}
      />
    </>
  );
}

/** A whole number typed into a settings field, or an error the Action shows. */
function wholeNumber(text: string, max: number): number {
  const value = Number(text);
  if (text.trim() === '' || !Number.isInteger(value) || value < 0 || value > max) {
    throw new Error(`Enter a whole number from 0 to ${max.toLocaleString('en-US')}.`);
  }
  return value;
}

/** How many records a collector may have waiting for review at once. */
function Cap({ token, onDone }: { token: AdminToken; onDone: (message: string) => void }) {
  const [cap, setCap] = useState(String(token.pending_cap ?? ''));
  return (
    <span className="undo">
      <input
        type="number"
        min={0}
        max={1000}
        value={cap}
        onChange={(event) => setCap(event.target.value)}
        aria-label={`Pending cap for ${token.label}`}
        className="narrow"
      />
      <Action
        label="Set cap"
        run={() => send('PATCH', `/tokens/${token.id}`, { pending_cap: wholeNumber(cap, 1000) })}
        onDone={() => onDone(`Cap for ${token.label} set to ${cap}.`)}
      />
    </span>
  );
}

/** How many verdicts a maintainer may send a day (UTC). It applies from its next lease. */
function DailyLimit({ token, onDone }: { token: AdminToken; onDone: (message: string) => void }) {
  const [limit, setLimit] = useState(String(token.daily_task_limit ?? 100));
  return (
    <span className="undo">
      <input
        type="number"
        min={0}
        max={10000}
        value={limit}
        onChange={(event) => setLimit(event.target.value)}
        aria-label={`Verdicts a day for ${token.label}`}
        className="narrow"
      />
      <Action
        label="Set daily limit"
        run={() => send('PATCH', `/tokens/${token.id}`, { daily_task_limit: wholeNumber(limit, 10000) })}
        onDone={() => onDone(`${token.label} may now send ${plural(Number(limit), 'verdict')} a day.`)}
      />
    </span>
  );
}

function Issue({ onIssued }: { onIssued: () => void }) {
  const [label, setLabel] = useState('');
  const [apps, setApps] = useState('*');
  const [limit, setLimit] = useState('100');
  const [expires, setExpires] = useState('');
  const [issued, setIssued] = useState<IssuedToken | null>(null);
  const [copied, setCopied] = useState(false);

  if (issued) {
    const skill = `${location.origin}/${issued.apps[0] === '*' ? dataApps[0]!.slug : issued.apps[0]}/SKILL.md`;
    const message = `Here is your maintainer token for Manyfold Data: ${issued.token}\nSave it as MANYFOLD_DATA_TOKEN in your agent workspace's .env file, never in a prompt or a repo.\nThen have your agent follow ${skill} on a schedule, for example every 4 hours.`;
    return (
      <section className="panel token-reveal">
        <h3>Token for {issued.label}</h3>
        <p>This is the only time it is shown. Send this to the owner privately:</p>
        <pre className="secret-message">{message}</pre>
        <div className="inline-form">
          <button
            type="button"
            className="quiet-button"
            onClick={() =>
              void navigator.clipboard.writeText(message).then(
                () => setCopied(true),
                () => undefined,
              )
            }
          >
            {copied ? 'Copied' : 'Copy message'}
          </button>
          <button type="button" className="quiet-button" onClick={() => setIssued(null)}>
            Done, hide it
          </button>
        </div>
      </section>
    );
  }

  return (
    <form
      className="panel inline-form"
      onSubmit={(event) => event.preventDefault()}
      aria-label="Issue a maintainer token"
    >
      <Field label="Who it is for">
        <input
          type="text"
          value={label}
          onChange={(event) => setLabel(event.target.value)}
          placeholder="Ada (house maintainer)"
        />
      </Field>
      <Field label="Data apps">
        <Select
          label="Data apps"
          value={apps}
          options={[{ value: '*', label: 'All data apps' }, ...dataApps.map((app) => ({ value: app.slug, label: app.title }))]}
          onChange={setApps}
        />
      </Field>
      <Field label="Tasks a day">
        <input
          type="number"
          min={1}
          value={limit}
          onChange={(event) => setLimit(event.target.value)}
          className="narrow"
        />
      </Field>
      <Field label="Expires (optional)">
        <DateField label="Expires (optional)" value={expires} onChange={setExpires} />
      </Field>
      <Action
        label="Issue maintainer token"
        run={() =>
          send<IssuedToken>('POST', '/tokens', {
            label,
            apps: [apps],
            daily_task_limit: Number(limit),
            ...(expires ? { expires_at: `${expires}T23:59:59Z` } : {}),
          })
        }
        onDone={(result) => {
          setIssued(result as IssuedToken);
          setLabel('');
          onIssued();
        }}
      />
    </form>
  );
}

/** Maintainer and collector tokens: issue, suspend, revoke or ban, undo, recheck. */
export default function TokensSection() {
  const { data, error, reload } = useAdmin<{ tokens: AdminToken[] }>('/tokens');
  const [message, setMessage] = useState<string | null>(null);
  const done = (text: string) => {
    setMessage(text);
    reload();
  };
  const maintainers = (data?.tokens ?? []).filter((token) => token.role === 'maintainer');
  const collectors = (data?.tokens ?? []).filter((token) => token.role === 'collector');

  return (
    <>
      <div className="section-head">
        <h2>Maintainers</h2>
        <span className="muted">{plural(maintainers.length, 'token')}</span>
      </div>
      <Notice error={error} message={message} />
      <Issue onIssued={reload} />
      <div className="table-wrap">
        <table className="records token-table">
          <thead>
            <tr>
              <th scope="col">Who</th>
              <th scope="col">Status</th>
              <th scope="col" className="num">
                Verdicts today
              </th>
              <th scope="col" className="num">
                All verdicts
              </th>
              <th scope="col">Last used</th>
              <th scope="col">Expires</th>
            </tr>
          </thead>
          <tbody>
            {maintainers.map((token) => (
              <Fragment key={token.id}>
                <tr className="has-actions">
                  <td className="wrap">
                    <Name token={token} onDone={done} />
                    <div className="muted small">{token.apps.join(', ')}</div>
                  </td>
                  <td>
                    <Badge value={token.status} />
                  </td>
                  <td className="num">
                    {formatCount(token.verdicts.today)} / {formatCount(token.daily_task_limit ?? 0)}
                  </td>
                  <td className="num">{formatCount(token.verdicts.total)}</td>
                  <td>
                    <When at={token.last_used_at} />
                  </td>
                  <td>{token.expires_at ? <When at={token.expires_at} /> : <span className="empty">never</span>}</td>
                </tr>
                <tr className="actions-row">
                  <td colSpan={6}>
                    <div className="row-actions">
                      <StatusActions token={token} onDone={done} />
                      {token.status === 'revoked' ? null : <DailyLimit token={token} onDone={done} />}
                      <Undo token={token} onDone={done} />
                    </div>
                  </td>
                </tr>
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>

      <div className="section-head">
        <h2>Collectors</h2>
        <span className="muted">{plural(collectors.length, 'token')}</span>
      </div>
      <div className="table-wrap">
        <table className="records token-table">
          <thead>
            <tr>
              <th scope="col">Agent</th>
              <th scope="col">Status</th>
              <th scope="col" className="num">
                Waiting
              </th>
              <th scope="col" className="num">
                Verified
              </th>
              <th scope="col" className="num">
                Rejected
              </th>
              <th scope="col" className="num">
                Accepted
              </th>
              <th scope="col">Last used</th>
            </tr>
          </thead>
          <tbody>
            {collectors.map((token) => (
              <Fragment key={token.id}>
                <tr className="has-actions">
                  <td className="wrap">
                    <Name token={token} onDone={done} />
                    <div className="muted small">{token.id}</div>
                  </td>
                  <td>
                    <Badge value={token.status} />
                  </td>
                  <td className="num">{formatCount(token.records.pending)}</td>
                  <td className="num">{formatCount(token.records.verified)}</td>
                  <td className="num">{formatCount(token.records.rejected)}</td>
                  <td className="num">
                    {share(token.records.verified, token.records.verified + token.records.rejected)}
                  </td>
                  <td>
                    <When at={token.last_used_at} />
                  </td>
                </tr>
                <tr className="actions-row">
                  <td colSpan={7}>
                    <div className="row-actions">
                      <StatusActions token={token} onDone={done} />
                      {token.status === 'revoked' ? null : <Cap token={token} onDone={done} />}
                      <Undo token={token} onDone={done} />
                    </div>
                  </td>
                </tr>
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
