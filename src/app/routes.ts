/** Paths to routes: plain TypeScript with no DOM or React, so tests can type-check it too. */

export type Route =
  | { name: 'catalog' }
  | { name: 'overview'; slug: string }
  | { name: 'table'; slug: string }
  | { name: 'record'; slug: string; id: string }
  | { name: 'settings'; section: string }
  | { name: 'privacy' }
  | { name: 'not-found' };

export function matchRoute(pathname: string): Route {
  let parts: string[];
  try {
    parts = pathname.split('/').filter(Boolean).map(decodeURIComponent);
  } catch {
    return { name: 'not-found' }; // a malformed escape such as /%E0
  }
  if (parts.length === 0) return { name: 'catalog' };
  const [slug, page, id] = parts as [string, string?, string?];
  if (slug === 'settings' && parts.length <= 2) return { name: 'settings', section: page ?? 'overview' };
  if (slug === 'privacy' && parts.length === 1) return { name: 'privacy' };
  if (parts.length === 1) return { name: 'overview', slug };
  if (parts.length === 2 && page === 'table') return { name: 'table', slug };
  if (parts.length === 3 && page === 'r' && id) return { name: 'record', slug, id };
  return { name: 'not-found' };
}
