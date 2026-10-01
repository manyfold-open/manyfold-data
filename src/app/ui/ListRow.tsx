/** A record as one phone row: avatar, title and a line under it, a figure and a date on the right. */

import type { ReactNode } from 'react';
import { Link } from '../router';
import { Avatar } from './controls';

export function ListRow({
  href,
  title,
  meta,
  value,
  sub,
}: {
  href: string;
  title: string;
  meta?: ReactNode;
  value?: ReactNode;
  sub?: ReactNode;
}) {
  return (
    <Link href={href} className="list-row">
      <Avatar name={title} size="md" />
      <span className="mid">
        <b>{title}</b>
        {meta ? <span>{meta}</span> : null}
      </span>
      <span className="end">
        {value !== undefined ? <b>{value}</b> : null}
        {sub ? <span>{sub}</span> : null}
      </span>
    </Link>
  );
}
