/**
 * "Request a data app", from the front page: a reader says what they would like tracked, and
 * the team reads it in Discord (the cron posts it: src/worker/requests.ts). A bottom sheet on
 * phones, a centered dialog on wider screens. A draft survives closing and reopening the
 * sheet; once a request is sent, the next open starts a fresh form.
 */

import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { REQUEST_LIMITS } from '../../shared/data-request';
import { track } from '../analytics';
import { ApiError, postJson } from '../api';
import { DISCORD_URL } from '../site';
import { Button, Icon, Sheet, Textarea, TextField } from '../ui';

interface Draft {
  topic: string;
  details: string;
  contact: string;
}

const EMPTY: Draft = { topic: '', details: '', contact: '' };

/** What went wrong, in words for the reader: never a count of seconds to wait. */
function problemOf(failure: unknown): string {
  if (!(failure instanceof ApiError)) return 'Could not reach the server. Please try again.';
  if (failure.status === 429) return 'Too many requests right now. Please try again later.';
  return failure.message;
}

export function RequestSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const id = useId();
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [state, setState] = useState<'writing' | 'sending' | 'sent'>('writing');
  const [error, setError] = useState('');
  const [wasOpen, setWasOpen] = useState(open);
  const thanks = useRef<HTMLDivElement>(null);

  // Opening again after a sent request starts afresh. Not on close: the thanks stays on screen
  // while the sheet slides away.
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open && state === 'sent') {
      setDraft(EMPTY);
      setState('writing');
    }
  }

  // The send button goes away with the form; focus moves to the thanks so it stays in the sheet.
  useEffect(() => {
    if (state === 'sent') thanks.current?.focus({ preventScroll: true });
  }, [state]);

  const edit = (field: keyof Draft) => (event: { target: { value: string } }) =>
    setDraft((previous) => ({ ...previous, [field]: event.target.value }));
  const ready = draft.topic.trim().length >= REQUEST_LIMITS.topicMin;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!ready || state === 'sending') return;
    setState('sending');
    setError('');
    try {
      await postJson('/api/requests', draft);
      track('data_requested', { data_app: 'site' });
      setState('sent');
    } catch (failure) {
      setError(problemOf(failure));
      setState('writing');
    }
  };

  const sent = state === 'sent';
  return (
    <Sheet
      open={open}
      title="Request a data app"
      onClose={onClose}
      action={
        sent ? undefined : (
          <button type="button" className="link-button" onClick={onClose}>
            Cancel
          </button>
        )
      }
      footer={
        sent ? undefined : (
          <Button type="submit" form={`${id}-form`} variant="primary" disabled={!ready || state === 'sending'}>
            {state === 'sending' ? 'Sending…' : 'Send request'}
          </Button>
        )
      }
    >
      {sent ? (
        <div ref={thanks} tabIndex={-1} className="request-sent" role="status">
          <p className="report-sent">
            <Icon name="check" size={18} />
            Thanks. Your request is with the team.
          </p>
          <p>
            We read every request. To follow along or tell us more,{' '}
            <a
              href={DISCORD_URL}
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => track('discord_joined', { data_app: 'site', placement: 'request' })}
            >
              join us on Discord
            </a>
            .
          </p>
        </div>
      ) : (
        <form id={`${id}-form`} className="request-form" noValidate onSubmit={(event) => void submit(event)}>
          <p className="intro">Tell us what you would like AI agents to collect and check. The team reads every request.</p>
          <div className="request-field">
            <label htmlFor={`${id}-topic`}>What should we track?</label>
            <TextField
              id={`${id}-topic`}
              data-autofocus
              required
              autoComplete="off"
              maxLength={REQUEST_LIMITS.topicMax}
              value={draft.topic}
              onChange={edit('topic')}
              placeholder="Open-weight model releases"
            />
          </div>
          <div className="request-field">
            <label htmlFor={`${id}-details`}>
              Details <span>(optional)</span>
            </label>
            <Textarea
              id={`${id}-details`}
              rows={4}
              maxLength={REQUEST_LIMITS.detailsMax}
              value={draft.details}
              onChange={edit('details')}
              placeholder="Why it matters to you, and where the data can be found"
            />
          </div>
          <div className="request-field">
            <label htmlFor={`${id}-contact`}>
              Email or Discord name <span>(optional)</span>
            </label>
            <TextField
              id={`${id}-contact`}
              autoComplete="email"
              maxLength={REQUEST_LIMITS.contactMax}
              value={draft.contact}
              onChange={edit('contact')}
              aria-describedby={`${id}-contact-hint`}
            />
            <p id={`${id}-contact-hint`} className="hint">
              Only if you would like a reply. It goes to our Discord with your request.
            </p>
          </div>
          {error ? (
            <p className="notice" role="alert">
              {error}
            </p>
          ) : null}
        </form>
      )}
    </Sheet>
  );
}
