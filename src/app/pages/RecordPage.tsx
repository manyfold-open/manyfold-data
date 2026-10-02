/**
 * One record: a header with its status and enum tags, every other field in a details grid,
 * the page and quote it was checked against, and its history. A merged record forwards to
 * the record it was merged into. On a phone the source comes first, and a bottom bar holds
 * Open source and Report.
 */

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
import { valueLabel, type DataAppConfig, type FieldDef } from '../../shared/data-app';
import type { MergedResponse, RecordResponse } from '../../shared/types';
import { track } from '../analytics';
import { postJson, useApi } from '../api';
import { titleOf } from '../components/RecordTable';
import { capitalize, displayUrl, formatShortDate, formatTime, formatValue, nounTitle, safeHref } from '../format';
import { useIsPhone } from '../hooks';
import { tableHrefFor } from '../memory';
import { shortLabel } from '../model/charts';
import { Link, navigate } from '../router';
import { Amount, Avatar, Button, ButtonLink, Icon, Skeleton, Tag, Textarea, usePending } from '../ui';
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

/** The field shown under the title: the second column, when it is text ("What it builds", "Organizer"). */
const subtitleOf = (config: DataAppConfig): string | null => {
  const field = config.table.columns[1];
  return field && config.fields[field]?.type === 'text' ? field : null;
};

/** Details read best with figures first, then dates, categories, lists, text and links. */
const ORDER: Record<FieldDef['type'], number> = { number: 0, date: 1, enum: 2, tags: 3, text: 4, url: 5 };

function Detail({ field, def, value }: { field: string; def: FieldDef; value: RecordResponse['record']['data'][string] | undefined }) {
  const long = (def.type === 'text' && String(value ?? '').length > 40) || (def.type === 'tags' && Array.isArray(value) && value.length > 2);
  let content;
  if (value === undefined || value === '' || (Array.isArray(value) && value.length === 0)) {
    content = formatValue(def, undefined) || <span className="none">Not stated</span>;
  }
  else if (typeof value === 'number') content = <Amount def={def} value={value} />;
  else if (Array.isArray(value)) {
    content = (
      <span className="tags">
        {value.map((item) => (
          <Tag key={item}>{item}</Tag>
        ))}
      </span>
    );
  } else if (def.type === 'url' && safeHref(value)) {
    content = (
      <a href={safeHref(value)!} {...EXTERNAL}>
        {formatValue(def, value)}
        <Icon name="external" size={13} />
      </a>
    );
  } else content = formatValue(def, value);
  return (
    <div className={long ? 'detail span2' : 'detail'} data-field={field}>
      <dt>{def.label}</dt>
      <dd>{content}</dd>
    </div>
  );
}

/** A reader tells the admin what is wrong with a record; it lands in the review queue. */
function Report({ config, id, open, setOpen }: { config: DataAppConfig; id: string; open: boolean; setOpen: (open: boolean) => void }) {
  const [reason, setReason] = useState('');
  const [state, setState] = useState<'writing' | 'sending' | 'sent'>('writing');
  const [error, setError] = useState('');
  const box = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!open) return;
    box.current?.focus({ preventScroll: true });
    box.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [open]);

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

  if (state === 'sent') {
    return (
      <p className="report-sent" role="status">
        <Icon name="check" size={16} />
        Thanks. The admin will check it against the source.
      </p>
    );
  }
  return (
    <>
      <button type="button" className="report-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Icon name="flag" size={14} />
        Report a problem
      </button>
      {open ? (
        <form className="report-form" onSubmit={(event) => void submit(event)}>
          <label htmlFor="report-reason">What is wrong with this {config.noun.one}?</label>
          <Textarea
            ref={box}
            id="report-reason"
            rows={3}
            maxLength={500}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="The source says something different."
          />
          {error ? (
            <p className="notice" role="alert">
              {error}
            </p>
          ) : null}
          <div className="row">
            <Button type="submit" variant="primary" disabled={state === 'sending' || reason.trim().length < 3}>
              {state === 'sending' ? 'Sending…' : 'Send report'}
            </Button>
            <Button onClick={() => setOpen(false)}>Cancel</Button>
          </div>
        </form>
      ) : null}
    </>
  );
}

function RecordSkeleton({ config }: { config: DataAppConfig }) {
  const count = Object.keys(config.fields).length - 1;
  return (
    <div aria-hidden="true">
      <div className="record-title">
        <Skeleton width={40} height={40} round />
        <Skeleton width="40%" height={26} />
      </div>
      <div className="record-tags">
        <Skeleton width={90} height={22} />
        <Skeleton width={70} height={22} />
      </div>
      <dl className="details">
        {Array.from({ length: Math.min(8, count) }, (_, index) => (
          <div key={index} className="detail">
            <Skeleton width="50%" height={11} />
            <Skeleton width="70%" height={16} style={{ marginTop: 4 }} />
          </div>
        ))}
      </dl>
    </div>
  );
}

export default function RecordPage({ config, id }: { config: DataAppConfig; id: string }) {
  const phone = useIsPhone();
  const { data, error } = useApi<RecordResponse | MergedResponse>(`/api/${config.slug}/records/${encodeURIComponent(id)}`);
  const found = data && 'record' in data ? data : null;
  const pending = usePending(!found && !error);
  const [reporting, setReporting] = useState(false);
  const name = found ? titleOf(config, found.record) : '';

  useEffect(() => {
    if (data && 'merged_into' in data) navigate(`/${config.slug}/r/${data.merged_into}`, { replace: true });
  }, [config.slug, data]);

  useEffect(() => {
    if (name) document.title = `${name} · ${config.title} · Manyfold Data`;
  }, [config.title, name]);

  const crumbs = (
    <nav className="crumbs" aria-label="Breadcrumb">
      <Link href={tableHrefFor(config.slug)}>{nounTitle(config)}</Link>
      <Icon name="right" size={14} />
      <span aria-current="page">{name || capitalize(config.noun.one)}</span>
    </nav>
  );

  if (error?.status === 404) return <NotFound message="This record does not exist, or it is not public." />;
  if (error) return <p className="notice">Could not load the record: {error.message}</p>;
  if (!found || pending.pending) {
    return (
      <div className={pending.visible ? 'sk-on' : undefined}>
        {phone ? null : crumbs}
        <RecordSkeleton config={config} />
      </div>
    );
  }

  const { record, revisions } = found;
  const titleField = config.table.columns[0] ?? '';
  const subField = subtitleOf(config);
  const subtitle = subField ? record.data[subField] : undefined;
  const enums = config.table.columns.filter((field) => config.fields[field]?.type === 'enum' && record.data[field]);
  const fallbacks = Object.values(config.table.fallback ?? {});
  const details = Object.entries(config.fields)
    .filter(([field]) => field !== titleField && field !== subField)
    // A stand-in field (amount as stated) shows only when it says something.
    .filter(([field]) => !fallbacks.includes(field) || record.data[field] !== undefined)
    .sort(([, a], [, b]) => ORDER[a.type] - ORDER[b.type]);
  const source = safeHref(record.source_url);

  return (
    <article className="record">
      {phone ? null : crumbs}
      <section className="record-body">
        <header>
          <div className="record-title">
            <Avatar name={name} size="lg" />
            <h1>{name}</h1>
          </div>
          <div className="record-tags">
            {record.status === 'verified' ? (
              <span className="status verified">
                <Icon name="check" size={15} />
                Verified{record.verified_at ? ` ${formatShortDate(record.verified_at)}` : ''}
              </span>
            ) : (
              <span className="status stale" title="A recheck found the source no longer agrees">
                <Icon name="warn" size={15} />
                May be out of date
              </span>
            )}
            {enums.map((field) => (
              <Tag key={field}>{shortLabel(valueLabel(config.fields[field], String(record.data[field])))}</Tag>
            ))}
            {typeof subtitle === 'string' ? <span className="sub">{subtitle}</span> : null}
          </div>
        </header>

        <section className="s-details" aria-labelledby="details-heading">
          <div className="section-head" style={phone ? undefined : { display: 'none' }}>
            <h2 id="details-heading">Details</h2>
          </div>
          <dl className="details">
            {details.map(([field, def]) => (
              <Detail key={field} field={field} def={def} value={record.data[field]} />
            ))}
          </dl>
        </section>

        <div className="record-cols">
          <section className="s-source source" aria-labelledby="source-heading">
            <div className="section-head">
              <h2 id="source-heading">Source</h2>
            </div>
            {source ? (
              <a href={source} className="source-link" {...EXTERNAL}>
                {displayUrl(record.source_url)}
                <Icon name="external" size={14} />
              </a>
            ) : (
              <span className="source-link">{displayUrl(record.source_url)}</span>
            )}
            {record.evidence ? <blockquote>{record.evidence}</blockquote> : null}
            <p className="read">Read on {formatTime(record.observed_at)}</p>
            <Report config={config} id={record.id} open={reporting} setOpen={setReporting} />
          </section>

          <section className="s-history" aria-labelledby="history-heading">
            <div className="section-head">
              <h2 id="history-heading">History</h2>
            </div>
            <ol className="history">
              {revisions.map((revision, index) => (
                <li key={`${revision.created_at}-${index}`} className={revision.action === 'verify' ? 'verify' : undefined}>
                  <div>
                    <b>{ACTIONS[revision.action] ?? revision.action}</b> by {revision.actor}
                    <time dateTime={revision.created_at}>{formatTime(revision.created_at)}</time>
                    {revision.reason ? <p>{revision.reason}</p> : null}
                  </div>
                </li>
              ))}
            </ol>
          </section>
        </div>
      </section>

      {phone
        ? createPortal(
            <div className="bottombar">
              <div className="actionbar">
                {source ? (
                  <ButtonLink variant="primary" href={source} external icon="external">
                    Open source
                  </ButtonLink>
                ) : null}
                <Button aria-label="Report a problem" icon="flag" onClick={() => setReporting(true)} />
              </div>
            </div>,
            document.body,
          )
        : null}
    </article>
  );
}
