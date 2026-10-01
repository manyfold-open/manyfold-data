/** Small pieces the /settings sections share. */

import { useEffect, useState, type ReactNode, type RefObject } from 'react';
import { ApiError } from '../api';
import { formatCount, formatTime } from '../format';

/** A status word with its colour; the word itself always carries the meaning. */
export function Badge({ value }: { value: string }) {
  return <span className={`badge badge-${value}`}>{value}</span>;
}

export const When = ({ at }: { at: string | null | undefined }) =>
  at ? <time dateTime={at}>{formatTime(at)}</time> : <span className="empty">never</span>;

export function Notice({ error, message }: { error?: ApiError | null; message?: string | null }) {
  if (error) return <p className="notice">{error.message}</p>;
  if (message) return <p className="notice good">{message}</p>;
  return null;
}

/**
 * A button that runs an action, shows that it is working, and reports what went wrong.
 * `confirm` asks first, for actions that are hard to undo.
 */
export function Action({
  label,
  run,
  confirm,
  tone,
  onDone,
}: {
  label: string;
  run: () => Promise<unknown>;
  confirm?: string;
  tone?: 'danger';
  onDone?: (result: unknown) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const click = async () => {
    if (confirm && !window.confirm(confirm)) return;
    setBusy(true);
    setError('');
    try {
      onDone?.(await run());
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };
  return (
    <span className="action">
      <button type="button" className={tone === 'danger' ? 'quiet-button danger' : 'quiet-button'} disabled={busy} onClick={() => void click()}>
        {busy ? 'Working…' : label}
      </button>
      {error ? <span className="action-error" role="alert">{error}</span> : null}
    </span>
  );
}

/** A labelled block for a form field. */
export const Field = ({ label, children }: { label: string; children: ReactNode }) => (
  <label className="field">
    <span>{label}</span>
    {children}
  </label>
);

/** "1 record", "3 records". */
export const plural = (count: number, one: string, other = `${one}s`): string =>
  `${formatCount(count)} ${count === 1 ? one : other}`;

/** "75%" of a part of a whole, or a dash when there is no whole yet. */
export const share = (part: number, whole: number): string => (whole > 0 ? `${Math.round((part / whole) * 100)}%` : '–');

/**
 * Gives every cell of the console's tables its column's name as data-label, so on a phone
 * (settings.css) each row can stack into a card that still says what every number is.
 */
export function useCellLabels(root: RefObject<HTMLElement | null>, mounted: boolean): void {
  useEffect(() => {
    const element = root.current;
    if (!element) return;
    const label = () => {
      for (const table of element.querySelectorAll('table.records')) {
        const heads = [...table.querySelectorAll('thead th')].map((th) => th.textContent?.trim() ?? '');
        for (const row of table.querySelectorAll('tbody tr')) {
          const cells = [...row.children] as HTMLElement[];
          if (cells.length !== heads.length) continue; // e.g. a row of actions spanning the table
          cells.forEach((cell, index) => {
            if (cell.dataset.label !== heads[index]) cell.dataset.label = heads[index];
          });
        }
      }
    };
    label();
    const observer = new MutationObserver(label);
    observer.observe(element, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [root, mounted]);
}
