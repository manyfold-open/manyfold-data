import { useState } from 'react';
import type { NotifyStatus } from '../../shared/types';
import { send, useAdmin } from './adminApi';
import { Action, Badge, Field, Notice, When } from './ui';

function App({ status, onChange }: { status: NotifyStatus; onChange: (message: string) => void }) {
  const [url, setUrl] = useState('');
  const path = `/notify/${status.slug}`;
  return (
    <section className="panel">
      <h3>
        {status.title} <Badge value={status.state} />
      </h3>
      {status.configured ? (
        <dl className="stat-row">
          <div>
            <dt>Webhook</dt>
            <dd className="small">{status.masked}</dd>
          </div>
          <div>
            <dt>Last post</dt>
            <dd className="small">
              <When at={status.last_sent_at} />
            </dd>
          </div>
          <div>
            <dt>Failures in a row</dt>
            <dd>{status.failures}</dd>
          </div>
          <div>
            <dt>Waiting</dt>
            <dd>{status.waiting}</dd>
          </div>
        </dl>
      ) : (
        <p className="muted">No Discord channel yet. Newly verified records are announced once one is set.</p>
      )}
      {status.last_error ? <p className="notice">Last error: {status.last_error}</p> : null}
      <form className="inline-form" onSubmit={(event) => event.preventDefault()}>
        <Field label={status.configured ? 'Replace the webhook' : 'Discord webhook URL'}>
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
      {status.configured ? (
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
          {status.state === 'paused' ? (
            <Action label="Resume" run={() => send('PATCH', path, { state: 'active' })} onDone={() => onChange('Announcements resumed.')} />
          ) : (
            <Action label="Pause" run={() => send('PATCH', path, { state: 'paused' })} onDone={() => onChange('Announcements paused.')} />
          )}
          <Action
            label="Remove"
            tone="danger"
            confirm="Remove this webhook? Announcements stop until a new one is set."
            run={() => send('DELETE', path)}
            onDone={() => onChange('Webhook removed.')}
          />
        </div>
      ) : null}
    </section>
  );
}

/** Each data app's Discord channel: the webhook, its delivery state, a test, pause and remove. */
export default function NotifySection() {
  const { data, error, reload } = useAdmin<{ apps: NotifyStatus[] }>('/notify');
  const [message, setMessage] = useState<string | null>(null);
  return (
    <>
      <div className="section-head">
        <h2>Discord</h2>
        <span className="muted">One post per cron run with the newly verified records</span>
      </div>
      <Notice error={error} message={message} />
      {(data?.apps ?? []).map((status) => (
        <App
          key={status.slug}
          status={status}
          onChange={(text) => {
            setMessage(text);
            reload();
          }}
        />
      ))}
    </>
  );
}
