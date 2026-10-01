/**
 * A small router over the History API — five routes do not need a dependency.
 *
 *   /                    catalog of data apps
 *   /settings[/:section] the admin console ('settings' is a reserved slug)
 *   /:slug               Overview
 *   /:slug/table         Table (its state lives in the query string)
 *   /:slug/r/:id         one record
 */

import { useEffect, useState, type AnchorHTMLAttributes, type MouseEvent } from 'react';

export { matchRoute, type Route } from './routes';

const CHANGE = 'manyfold:navigate';

const current = () => ({ pathname: location.pathname, search: location.search });

/** The address bar's path and query, updated on every navigation and on back/forward. */
export function useLocation(): { pathname: string; search: string } {
  const [state, setState] = useState(current);
  useEffect(() => {
    const update = () => setState(current());
    window.addEventListener('popstate', update);
    window.addEventListener(CHANGE, update);
    return () => {
      window.removeEventListener('popstate', update);
      window.removeEventListener(CHANGE, update);
    };
  }, []);
  return state;
}

/** Go to a same-origin URL. A new path scrolls to the top; a new query alone does not. */
export function navigate(href: string, options: { replace?: boolean } = {}): void {
  const target = new URL(href, location.href);
  if (target.pathname === location.pathname && target.search === location.search) return;
  const samePath = target.pathname === location.pathname;
  history[options.replace ? 'replaceState' : 'pushState'](null, '', target.pathname + target.search);
  window.dispatchEvent(new Event(CHANGE));
  if (!samePath) window.scrollTo(0, 0);
}

/** An <a> that navigates in place, unless the reader asked for a new tab or window. */
export function Link({ href, onClick, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) {
  const handle = (event: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(event);
    if (event.defaultPrevented || event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    navigate(href);
  };
  return <a href={href} onClick={handle} {...rest} />;
}
