/**
 * /settings: the admin console. One password (the ADMIN_PASSWORD secret) opens it for
 * this browser tab. Sections live at /settings/<section>; the data app a section shows
 * is ?app=<slug>, and an open record is ?record=<id>.
 */

import { useEffect, useRef, useState, type FormEvent } from 'react';
import './settings.css';
import { dataApps } from '../../../data-apps/index';
import { ApiError } from '../api';
import NotFound from '../pages/NotFound';
import { Link, navigate } from '../router';
import { Select } from '../ui';
import ActivitySection from './ActivitySection';
import { admin, storedPassword, storePassword, whenLocked } from './adminApi';
import NotifySection from './NotifySection';
import OverviewSection from './OverviewSection';
import RecordsSection from './RecordsSection';
import ReviewSection from './ReviewSection';
import SpotCheckSection from './SpotCheckSection';
import TokensSection from './TokensSection';
import { Field, useCellLabels } from './ui';

/** `perApp` sections show one data app at a time. */
const SECTIONS = [
  { id: 'overview', label: 'Overview', perApp: false },
  { id: 'review', label: 'Review', perApp: true },
  { id: 'records', label: 'Records', perApp: true },
  { id: 'tokens', label: 'Tokens', perApp: false },
  { id: 'activity', label: 'Activity', perApp: true },
  { id: 'spot-check', label: 'Spot-check', perApp: true },
  { id: 'discord', label: 'Discord', perApp: false },
] as const;

type SectionId = (typeof SECTIONS)[number]['id'];

function Gate({ onOpen }: { onOpen: () => void }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    storePassword(password);
    try {
      await admin('/overview');
      onOpen();
    } catch (failure) {
      setError(
        failure instanceof ApiError && failure.status === 401
          ? 'That is not the admin password.'
          : failure instanceof Error
            ? failure.message
            : 'Could not reach the server.',
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="panel gate" onSubmit={(event) => void submit(event)}>
      <h1>Settings</h1>
      <p className="muted">For the admin of Manyfold Data. The password stays in this tab until you lock it or close the tab.</p>
      <Field label="Admin password">
        <input type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} autoFocus />
      </Field>
      {error ? (
        <p className="notice" role="alert">
          {error}
        </p>
      ) : null}
      <button type="submit" className="quiet-button" disabled={busy || !password}>
        {busy ? 'Checking…' : 'Open settings'}
      </button>
    </form>
  );
}

export default function SettingsPage({ section, search }: { section: string; search: string }) {
  const [open, setOpen] = useState(() => storedPassword() !== '');
  useEffect(() => {
    whenLocked(() => setOpen(false));
    return () => whenLocked(null);
  }, []);

  const root = useRef<HTMLDivElement>(null);
  useCellLabels(root, open);
  // On a phone the section tabs scroll sideways; keep the current one in view.
  useEffect(() => {
    const nav = root.current?.querySelector<HTMLElement>('.settings-nav');
    const tab = nav?.querySelector<HTMLElement>('[aria-current="page"]');
    if (nav && tab) nav.scrollLeft = tab.offsetLeft - (nav.clientWidth - tab.offsetWidth) / 2;
  }, [open, section]);

  const current = SECTIONS.find((entry) => entry.id === section);
  if (!current) return <NotFound message="There is no settings section by that name." />;
  if (!open) return <Gate onOpen={() => setOpen(true)} />;

  const params = new URLSearchParams(search);
  const slug = dataApps.some((config) => config.slug === params.get('app')) ? params.get('app')! : dataApps[0]!.slug;
  const href = (id: SectionId, extra: Record<string, string> = {}) => {
    const query = new URLSearchParams({ ...(slug === dataApps[0]!.slug ? {} : { app: slug }), ...extra }).toString();
    return `/settings/${id}${query ? `?${query}` : ''}`;
  };
  const openRecord = (id: string | null) => navigate(id ? href('records', { record: id }) : href('records'));
  const lock = () => {
    storePassword('');
    setOpen(false);
  };

  let body;
  switch (current.id) {
    case 'overview':
      body = <OverviewSection />;
      break;
    case 'review':
      body = <ReviewSection slug={slug} onOpen={openRecord} />;
      break;
    case 'records':
      body = <RecordsSection key={slug} slug={slug} openId={params.get('record')} onOpen={openRecord} />;
      break;
    case 'tokens':
      body = <TokensSection />;
      break;
    case 'activity':
      body = <ActivitySection key={slug} slug={slug} onOpen={openRecord} />;
      break;
    case 'spot-check':
      body = <SpotCheckSection key={slug} slug={slug} />;
      break;
    case 'discord':
      body = <NotifySection />;
      break;
  }

  return (
    <div className="settings" ref={root}>
      <div className="settings-bar">
        <nav className="settings-nav" aria-label="Settings">
          {SECTIONS.map((entry) => (
            <Link key={entry.id} href={href(entry.id)} aria-current={entry.id === current.id ? 'page' : undefined}>
              {entry.label}
            </Link>
          ))}
        </nav>
        <div className="settings-tools">
          {current.perApp && dataApps.length > 1 ? (
            <Select
              label="Data app"
              value={slug}
              options={dataApps.map((config) => ({ value: config.slug, label: config.title }))}
              onChange={(next) => navigate(`/settings/${current.id}?app=${encodeURIComponent(next)}`)}
            />
          ) : null}
          <button type="button" className="quiet-button" onClick={lock}>
            Lock
          </button>
        </div>
      </div>
      {body}
    </div>
  );
}
