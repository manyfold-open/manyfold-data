import { useState, type ReactNode } from 'react';
import type { DataRequest, DataRequestsAdmin, DiscordChannel, NotifyStatus } from '../../shared/types';
import { send, useAdmin } from './adminApi';
import { Action, Badge, Field, Notice, When } from './ui';

/**
 * One Discord channel: the webhook, its delivery state, a test, pause and remove. `path` is the
 * channel under /api/admin; `children` holds what only this kind of channel has.
 */
function Channel({
  title,
  path,
  channel,
  empty,
  onChange,
  children,
}: {
  title: string;
  path: string;
  channel: DiscordChannel;
  empty: string;
  onChange: (message: string) => void;
  children?: ReactNode;
}) {
  const [url, setUrl] = useState('');
  return (
    <section className="panel">
      <h3>
        {title} <Badge value={channel.state} />
      </h3>
      {channel.configured ? (
        <dl className="stat-row">
          <div>
            <dt>Webhook</dt>
            <dd className="small">{channel.masked}</dd>
          </div>
          <div>
            <dt>Last post</dt>
            <dd className="small">
              <When at={channel.last_sent_at} />
            </dd>
          </div>
          <div>
            <dt>Failures in a row</dt>
            <dd>{channel.failures}</dd>
          </div>
          <div>
            <dt>Waiting</dt>
            <dd>{channel.waiting}</dd>
          </div>
        </dl>
      ) : (
        <p className="muted">{empty}</p>
      )}
      {channel.last_error ? <p className="notice">Last error: {channel.last_error}</p> : null}
      <form className="inline-form" onSubmit={(event) => event.preventDefault()}>
        <Field label={channel.configured ? 'Replace the webhook' : 'Discord webhook URL'}>
          <input
            type="password"
            autoComplete="off"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            placeholder="https://discord.com/api/webhooks/…"
          />
        </Field>
        <Action
          label="Save webhook"
          run={() => send('PUT', path, { webhook_url: url.trim() })}
          onDone={() => {
            setUrl('');
            onChange('Webhook saved, sealed with the encryption key.');
          }}
        />
      </form>
      {children}
      {channel.configured ? (
        <div className="inline-form">
          <Action
            label="Send a test message"
            confirm="Post a test message to this Discord channel?"
            run={() => send<{ ok: boolean; status: number }>('POST', `${path}/test`)}
            onDone={(result) => {
              const outcome = result as { ok: boolean; status: number };
              onChange(outcome.ok ? 'Test message posted.' : `Discord refused the test: HTTP ${outcome.status}.`);
            }}
          />
          {channel.state === 'paused' ? (
            <Action label="Resume" run={() => send('PATCH', path, { state: 'active' })} onDone={() => onChange('Posts resumed.')} />
          ) : (
            <Action label="Pause" run={() => send('PATCH', path, { state: 'paused' })} onDone={() => onChange('Posts paused.')} />
          )}
          <Action
            label="Remove"
            tone="danger"
            confirm="Remove this webhook? Posts stop until a new one is set."
            run={() => send('DELETE', path)}
            onDone={() => onChange('Webhook removed.')}
          />
        </div>
      ) : null}
    </section>
  );
}

/** A data app's public invite link, which its Overview shows at the bottom. */
function Invite({ status, onChange }: { status: NotifyStatus; onChange: (message: string) => void }) {
  const [invite, setInvite] = useState(status.invite_url ?? '');
  return (
    <form className="inline-form" onSubmit={(event) => event.preventDefault()}>
      <Field label="Invite link, shown at the bottom of the Overview">
        <input type="url" value={invite} onChange={(event) => setInvite(event.target.value)} placeholder="https://discord.gg/…" />
      </Field>
      <Action
        label="Save invite"
        run={() => send('PATCH', `/notify/${status.slug}`, { invite_url: invite.trim() || null })}
        onDone={() => onChange(invite.trim() ? 'Invite saved: the Overview now asks readers to join.' : 'Invite removed.')}
      />
      {status.invite_url ? (
        <a href={status.invite_url} target="_blank" rel="noopener noreferrer" className="small">
          Open the current invite ↗
        </a>
      ) : null}
    </form>
  );
}

/** What readers asked for from the front page, newest first, whether posted yet or waiting. */
function Requests({ items, onChange }: { items: DataRequest[]; onChange: (message: string) => void }) {
  return (
    <section className="panel">
      <h3>Latest data requests</h3>
      {items.length === 0 ? (
        <p className="muted">None yet. Readers send them from the "Request a data app" card on the front page.</p>
      ) : (
        <div className="table-wrap">
          <table className="records">
            <thead>
              <tr>
                <th scope="col">Request</th>
                <th scope="col">Contact</th>
                <th scope="col">Received</th>
                <th scope="col">Posted</th>
                <th scope="col">
                  <span className="visually-hidden">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id}>
                  <td>
                    <b>{item.topic}</b>
                    {item.details ? <p className="small muted">{item.details}</p> : null}
                  </td>
                  <td className="wrap">{item.contact ?? <span className="empty">none</span>}</td>
                  <td>
                    <When at={item.created_at} />
                  </td>
                  <td>{item.sent_at ? <When at={item.sent_at} /> : <span className="empty">waiting</span>}</td>
                  <td>
                    <Action
                      label="Delete"
                      tone="danger"
                      confirm="Delete this request? A post already sent stays in Discord: delete it there too."
                      run={() => send('DELETE', `/requests/${item.id}`)}
                      onDone={() => onChange('Request deleted.')}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/**
 * The site's Discord channels: the requests channel, where readers' data requests are posted,
 * then each data app's announcements. Each has its webhook, delivery state, a test, pause and remove.
 */
export default function NotifySection() {
  const apps = useAdmin<{ apps: NotifyStatus[] }>('/notify');
  const requests = useAdmin<DataRequestsAdmin>('/requests');
  const [message, setMessage] = useState<string | null>(null);
  const onChange = (text: string) => {
    setMessage(text);
    apps.reload();
    requests.reload();
  };
  return (
    <>
      <div className="section-head">
        <h2>Discord</h2>
        <span className="muted">At most one post per channel per cron run</span>
      </div>
      <Notice error={apps.error ?? requests.error} message={message} />
      {requests.data ? (
        <>
          <Channel
            title="Data requests"
            path="/requests/discord"
            channel={requests.data.channel}
            empty="No channel yet. Requests from the front page wait here and are posted once a webhook is set. Use a private channel: a request can carry the reader's email."
            onChange={onChange}
          />
          <Requests items={requests.data.items} onChange={onChange} />
        </>
      ) : null}
      {(apps.data?.apps ?? []).map((status) => (
        <Channel
          key={status.slug}
          title={status.title}
          path={`/notify/${status.slug}`}
          channel={status}
          empty="No Discord channel yet. Newly verified records are announced once one is set."
          onChange={onChange}
        >
          <Invite status={status} onChange={onChange} />
        </Channel>
      ))}
    </>
  );
}
