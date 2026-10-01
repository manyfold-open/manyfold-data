/**
 * A calendar date typed as YYYY-MM-DD, without the browser's date picker. It reports a value
 * only once the text is a real date (or empty), and marks itself invalid in between.
 */

import { useEffect, useState } from 'react';
import { isIsoDate } from '../../shared/data-app';

export function DateField({
  value,
  onChange,
  id,
  label,
}: {
  value: string;
  onChange: (value: string) => void;
  id?: string;
  label?: string;
}) {
  const [text, setText] = useState(value);
  useEffect(() => setText((current) => (current === value || !isIsoDate(value) ? current : value)), [value]);
  const invalid = text !== '' && !isIsoDate(text);
  return (
    <input
      id={id}
      type="text"
      inputMode="numeric"
      autoComplete="off"
      placeholder="YYYY-MM-DD"
      maxLength={10}
      aria-label={label}
      aria-invalid={invalid || undefined}
      className="date-field"
      value={text}
      onChange={(event) => {
        // Digits typed straight through get their hyphens: 20261231 → 2026-12-31.
        const digits = event.target.value.replace(/[^\d-]/g, '');
        const next = /^\d{8}$/.test(digits) ? `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6)}` : digits;
        setText(next);
        if (next === '' || isIsoDate(next)) onChange(next);
        else if (value !== '') onChange('');
      }}
    />
  );
}
