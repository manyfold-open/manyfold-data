/**
 * The shell: header, the page for the current route, footer. Data apps come from
 * data-apps/index.ts at build time, so an unknown slug is a 404 without a request.
 */

import { lazy, Suspense, useEffect } from 'react';
import { findDataApp } from '../../data-apps/index';
import CatalogPage from './pages/CatalogPage';
import NotFound from './pages/NotFound';
import OverviewPage from './pages/OverviewPage';
import RecordPage from './pages/RecordPage';
import TablePage from './pages/TablePage';
import { Link, matchRoute, useLocation } from './router';

// The admin console is its own chunk, so readers never download it.
const SettingsPage = lazy(() => import('./settings/SettingsPage'));

const SITE = 'Manyfold Data';

export default function App() {
  const { pathname, search } = useLocation();
  const route = matchRoute(pathname);
  const config = 'slug' in route ? findDataApp(route.slug) : undefined;
  const known = route.name === 'catalog' || route.name === 'settings' || (route.name !== 'not-found' && config !== undefined);

  useEffect(() => {
    if (route.name === 'record') return; // the record page names itself once loaded
    document.title =
      route.name === 'catalog'
        ? SITE
        : route.name === 'settings'
          ? `Settings · ${SITE}`
          : !known || !config
            ? `Not found · ${SITE}`
            : route.name === 'table'
              ? `Table · ${config.title} · ${SITE}`
              : `${config.title} · ${SITE}`;
  }, [config, known, route.name]);

  let page;
  if (route.name === 'catalog') page = <CatalogPage />;
  else if (route.name === 'settings') {
    page = (
      <Suspense fallback={<p className="muted">Loading</p>}>
        <SettingsPage section={route.section} search={search} />
      </Suspense>
    );
  }
  else if (!config || route.name === 'not-found') page = <NotFound />;
  else if (route.name === 'overview') page = <OverviewPage config={config} />;
  else if (route.name === 'table') page = <TablePage key={config.slug} config={config} search={search} />;
  else page = <RecordPage key={route.id} config={config} id={route.id} />;

  return (
    <div className="site">
      <header className="site-header">
        <div className="header-inner">
          <Link href="/" className="brand">
            <img src="/favicon.svg" alt="" width="24" height="24" />
            {SITE}
          </Link>
          {config && known ? (
            <nav className="app-nav" aria-label={config.title}>
              <span className="app-name">{config.title}</span>
              <Link href={`/${config.slug}`} aria-current={route.name === 'overview' ? 'page' : undefined}>
                Overview
              </Link>
              <Link href={`/${config.slug}/table`} aria-current={route.name === 'table' ? 'page' : undefined}>
                Table
              </Link>
            </nav>
          ) : null}
        </div>
      </header>
      <main className="site-main">{page}</main>
      <footer className="site-footer">
        <p>
          Data is CC BY 4.0, code is MIT. Every record links to the page it was checked against. Built on{' '}
          <a href="https://manyfold.ai" target="_blank" rel="noopener noreferrer">
            Manyfold
          </a>
          .
        </p>
      </footer>
    </div>
  );
}
