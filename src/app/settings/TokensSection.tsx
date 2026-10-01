import { Fragment, useState } from 'react';
import { dataApps } from '../../../data-apps/index';
import type { AdminToken, IssuedToken, RevertReport } from '../../shared/types';
import { formatCount, formatTime } from '../format';
import { send, useAdmin } from './adminApi';
import { Action, Badge, Field, Notice, plural, share, When } from './ui';

/** 24 hours ago as a datetime-local value, which is in the browser's own time zone. */
function dayAgo(): string {
  const at = new Date(Date.now() - 24 * 60 * 60 * 1000);
  at.setMinutes(at.getMinutes() - at.getTimezoneOffset());
  return at.toISOString().slice(0, 16);
}

/** Undo a token's changes since a moment the admin picks (default: 24 hours ago). */
function Undo({ token, onDone }: { token: AdminToken; onDone: (message: string) => void }) {
  const [since, setSince] = useState(dayAgo);
  return (
    <span className="undo">
      <input
        type="datetime-local"
        value={since}
        onChange={(event) => setSince(event.target.value)}
        aria-label={`Undo ${token.label} since`}
      />
      <Action
        label="Undo since"
        tone="danger"
        confirm={`Undo every change ${token.label} made since ${formatTime(new Date(since).toISOString())}?`}
        run={() =>
          send<RevertReport>('POST', `/tokens/${token.id}/revert`, {
            since: new Date(since).toISOString(),
          })
        }
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

function Cap({ token, onDone }: { token: AdminToken; onDone: (message: string) => void }) {
  const [cap, setCap] = useState(String(token.pending_cap ?? ''));
  return (
    <span className="undo">
      <input
        type="number"
        min={0}
        value={cap}
        onChange={(event) => setCap(event.target.value)}
        aria-label={`Pending cap for ${token.label}`}
        className="narrow"
      />
      <Action
        label="Set cap"
        run={() => send('PATCH', `/tokens/${token.id}`, { pending_cap: Number(cap) })}
        onDone={() => onDone(`Cap for ${token.label} set to ${cap}.`)}
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
        <select value={apps} onChange={(event) => setApps(event.target.value)}>
          <option value="*">All data apps</option>
          {dataApps.map((app) => (
            <option key={app.slug} value={app.slug}>
              {app.title}
            </option>
          ))}
        </select>
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
        <input type="date" value={expires} onChange={(event) => setExpires(event.target.value)} />
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
                    {token.label}
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
                    {token.label}
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
                      <Cap token={token} onDone={done} />
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
