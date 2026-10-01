/**
 * The reader's controls. Every one is our own: no native select, checkbox, radio or date
 * picker appears outside this folder (tests/native-controls.test.ts keeps it that way).
 * Each control has its ARIA role and keyboard behavior, and a visible focus ring.
 */

import {
  forwardRef,
  useEffect,
  useId,
  useRef,
  type AnchorHTMLAttributes,
  type ButtonHTMLAttributes,
  type KeyboardEvent,
  type ReactNode,
  type TextareaHTMLAttributes,
} from 'react';
import { amountParts, hueOf, initials } from '../format';
import { Link } from '../router';
import type { FieldDef } from '../../shared/data-app';
import { Icon, Tick, type IconName } from './Icon';

const cx = (...names: (string | false | null | undefined)[]) => names.filter(Boolean).join(' ');

/* ───────── buttons ───────── */

type Variant = 'primary' | 'secondary';

export const Button = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; icon?: IconName }
>(function Button({ variant = 'secondary', icon, className, children, type = 'button', ...rest }, ref) {
  return (
    <button ref={ref} type={type} className={cx('btn', variant, className)} {...rest}>
      {icon ? <Icon name={icon} size={16} /> : null}
      {children}
    </button>
  );
});

/** A link that looks like a button. External links open in a new tab without a referrer. */
export function ButtonLink({
  variant = 'secondary',
  icon,
  external,
  className,
  children,
  href,
  ...rest
}: AnchorHTMLAttributes<HTMLAnchorElement> & { href: string; variant?: Variant; icon?: IconName; external?: boolean }) {
  const classes = cx('btn', variant, className);
  if (external) {
    return (
      <a className={classes} href={href} target="_blank" rel="nofollow ugc noopener noreferrer" {...rest}>
        {children}
        {icon ? <Icon name={icon} size={16} /> : null}
      </a>
    );
  }
  return (
    <Link className={classes} href={href} {...rest}>
      {icon ? <Icon name={icon} size={16} /> : null}
      {children}
    </Link>
  );
}

/**
 * A hover and focus tooltip. `end` anchors it to the right edge, for controls at the edge
 * of the screen. When the tooltip only repeats the control's accessible name (an icon
 * button), it is hidden from assistive tech; otherwise the control gets aria-describedby.
 */
export function Tooltip({
  text,
  end,
  repeatsLabel,
  children,
}: {
  text: string;
  end?: boolean;
  repeatsLabel?: boolean;
  children: (describedBy: string | undefined) => ReactNode;
}) {
  const id = useId();
  return (
    <span className={cx('tip-wrap', end && 'end')}>
      {children(repeatsLabel ? undefined : id)}
      {repeatsLabel ? (
        <span className="tip" aria-hidden="true">
          {text}
        </span>
      ) : (
        <span role="tooltip" id={id} className="tip">
          {text}
        </span>
      )}
    </span>
  );
}

/** A round icon-only button. `label` is its accessible name and its tooltip. */
export function IconButton({
  icon,
  label,
  tooltip = true,
  end,
  className,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { icon: IconName; label: string; tooltip?: boolean; end?: boolean }) {
  const button = (
    <button type="button" className={cx('icon-button', className)} aria-label={label} {...rest}>
      <Icon name={icon} size={18} />
    </button>
  );
  return tooltip ? (
    <Tooltip text={label} end={end} repeatsLabel>
      {() => button}
    </Tooltip>
  ) : (
    button
  );
}

/* ───────── choices ───────── */

/** Arrow keys move between the radios of a group, as native radios do. */
function onRadioKeys(event: KeyboardEvent<HTMLElement>) {
  const keys = ['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp', 'Home', 'End'];
  if (!keys.includes(event.key)) return;
  const radios = [...event.currentTarget.querySelectorAll<HTMLElement>('[role="radio"]')];
  const index = radios.indexOf(document.activeElement as HTMLElement);
  if (index < 0) return;
  event.preventDefault();
  const forward = event.key === 'ArrowRight' || event.key === 'ArrowDown';
  const next =
    event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? radios.length - 1
        : (index + (forward ? 1 : -1) + radios.length) % radios.length;
  radios[next]?.focus();
  radios[next]?.click();
}

export interface Choice<T extends string> {
  value: T;
  label: ReactNode;
  /** Small text after the label, e.g. a count. */
  note?: ReactNode;
}

/** One choice of several, as pills: date ranges, amount thresholds. */
export function RadioPills<T extends string>({
  label,
  choices,
  value,
  onChange,
}: {
  label: string;
  choices: readonly Choice<T>[];
  value: T | null;
  onChange: (value: T) => void;
}) {
  return (
    <div className="pills" role="radiogroup" aria-label={label} onKeyDown={onRadioKeys}>
      {choices.map((choice, index) => {
        const checked = choice.value === value;
        return (
          <button
            key={choice.value}
            type="button"
            role="radio"
            aria-checked={checked}
            tabIndex={checked || (value === null && index === 0) ? 0 : -1}
            className="pill"
            onClick={() => onChange(choice.value)}
          >
            {choice.label}
            {choice.note !== undefined ? <em>{choice.note}</em> : null}
          </button>
        );
      })}
    </div>
  );
}

/** Two or three views of one thing: Chart / Table. */
export function Segmented<T extends string>({
  label,
  choices,
  value,
  onChange,
}: {
  label: string;
  choices: readonly Choice<T>[];
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <div className="segmented" role="radiogroup" aria-label={label} onKeyDown={onRadioKeys}>
      {choices.map((choice) => (
        <button
          key={choice.value}
          type="button"
          role="radio"
          aria-checked={choice.value === value}
          tabIndex={choice.value === value ? 0 : -1}
          onClick={() => onChange(choice.value)}
        >
          {choice.label}
        </button>
      ))}
    </div>
  );
}

/** A filter that is on or off, as a pill: the phone's Filters and Sort buttons. */
export function Pill({
  active,
  icon,
  children,
  className,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { active?: boolean; icon?: IconName }) {
  return (
    <button type="button" className={cx('pill', active && 'active', className)} {...rest}>
      {icon ? <Icon name={icon} size={15} /> : null}
      {children}
    </button>
  );
}

/** A checkbox row: a 16px box, the label (and a line under it), the count on the right. */
export function CheckRow({
  checked,
  label,
  sub,
  count,
  onToggle,
}: {
  checked: boolean;
  label: ReactNode;
  sub?: ReactNode;
  count?: number | null;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      className={cx('check-row', count === 0 && !checked && 'zero')}
      onClick={onToggle}
    >
      <span className="box">
        <Tick />
      </span>
      <span>
        {label}
        {sub ? <small>{sub}</small> : null}
      </span>
      <span className="count">{count === null || count === undefined ? '' : count.toLocaleString('en-US')}</span>
    </button>
  );
}

/** "Show all 12" under a long list. */
export function ShowAll({ expanded, total, onToggle, less = 'Show less' }: { expanded: boolean; total: number; onToggle: () => void; less?: string }) {
  return (
    <button type="button" className="show-all" aria-expanded={expanded} onClick={onToggle}>
      {expanded ? less : `Show all ${total.toLocaleString('en-US')}`}
      <Icon name="down" size={16} />
    </button>
  );
}

/* ───────── text ───────── */

/**
 * A search box with a clear button. `/` focuses it from anywhere on the page unless the
 * reader is typing somewhere else.
 */
export function SearchField({
  value,
  label,
  onChange,
  onSubmit,
  shortcut = true,
  maxLength,
}: {
  value: string;
  label: string;
  onChange: (value: string) => void;
  onSubmit?: () => void;
  shortcut?: boolean;
  maxLength?: number;
}) {
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!shortcut) return;
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest('input, textarea, [contenteditable="true"]')) return;
      event.preventDefault();
      input.current?.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [shortcut]);

  return (
    <div className="search">
      <Icon name="search" size={16} />
      <input
        ref={input}
        type="text"
        role="searchbox"
        enterKeyHint="search"
        autoComplete="off"
        spellCheck={false}
        placeholder={label}
        aria-label={label}
        aria-keyshortcuts={shortcut ? '/' : undefined}
        maxLength={maxLength}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && value) {
            event.preventDefault();
            onChange('');
          } else if (event.key === 'Enter') onSubmit?.();
        }}
      />
      {value ? (
        <button
          type="button"
          className="search-clear"
          aria-label="Clear search"
          onClick={() => {
            onChange('');
            input.current?.focus();
          }}
        >
          <Icon name="close" size={12} />
        </button>
      ) : shortcut ? (
        <kbd aria-hidden="true">/</kbd>
      ) : null}
    </div>
  );
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea(
  { className, ...rest },
  ref,
) {
  return <textarea ref={ref} className={cx('textarea', className)} {...rest} />;
});

/* ───────── labels ───────── */

export const Tag = ({ children }: { children: ReactNode }) => <span className="tag">{children}</span>;

/** An applied filter; clicking it removes it. */
export function Chip({ label, onRemove }: { label: string; onRemove: () => void }) {
  return (
    <button type="button" className="chip" onClick={onRemove} aria-label={`Remove filter: ${label}`}>
      {label}
      <span className="chip-x" aria-hidden="true">
        <Icon name="close" size={12} />
      </span>
    </button>
  );
}

/** A record's initials in a circle whose color comes from its name. */
export function Avatar({ name, size }: { name: string; size?: 'md' | 'lg' }) {
  return (
    <span className={cx('avatar', size)} style={{ ['--h' as string]: hueOf(name) }} aria-hidden="true">
      {initials(name)}
    </span>
  );
}

/** A number with its small unit: 9.5 M USD. */
export function Amount({ def, value }: { def: FieldDef | undefined; value: number }) {
  const { number, unit } = amountParts(def, value);
  return (
    <span className="tnum">
      {number}
      {unit ? <span className="unit">{unit}</span> : null}
    </span>
  );
}
