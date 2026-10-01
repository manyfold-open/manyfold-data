/**
 * The shell: top bar, the page for the current route, footer, and on phones the bottom bar.
 * Data apps come from data-apps/index.ts at build time, so an unknown slug is a 404 without
 * a request.
 */

import { lazy, Suspense, useEffect, useState } from 'react';
import { findDataApp } from '../../data-apps/index';
import Consent from './components/Consent';
import { ContributeSheet } from './components/ContributeSheet';
import { TabBar, TopBar } from './components/Shell';
import { nounTitle } from './format';
import { useIsPhone } from './hooks';
import CatalogPage from './pages/CatalogPage';
import NotFound from './pages/NotFound';
import OverviewPage from './pages/OverviewPage';
import PrivacyPage from './pages/PrivacyPage';
import RecordPage from './pages/RecordPage';
import TablePage from './pages/TablePage';
import { Link, matchRoute, useLocation } from './router';
import { SITE } from './site';
import { ManyfoldMark, ToastProvider } from './ui';

// The admin console is its own chunk, so readers never download it.
const SettingsPage = lazy(() => import('./settings/SettingsPage'));

export default function App() {
  const { pathname, search } = useLocation();
  const route = matchRoute(pathname);
  const config = 'slug' in route ? findDataApp(route.slug) : undefined;
  const known =
    route.name === 'catalog' ||
    route.name === 'settings' ||
    route.name === 'privacy' ||
    (route.name !== 'not-found' && config !== undefined);
  const app = known ? config : undefined;
  const phone = useIsPhone();
  const [contributing, setContributing] = useState(false);

  useEffect(() => {
    if (route.name === 'record' || route.name === 'privacy') return; // these pages name themselves
    document.title =
      route.name === 'catalog'
        ? SITE
        : route.name === 'settings'
          ? `Settings · ${SITE}`
          : !known || !config
            ? `Not found · ${SITE}`
            : route.name === 'table'
              ? `${nounTitle(config)} · ${config.title} · ${SITE}`
              : `${config.title} · ${SITE}`;
  }, [config, known, route.name]);

  useEffect(() => setContributing(false), [pathname]);

  let page;
  if (route.name === 'catalog') page = <CatalogPage />;
  else if (route.name === 'privacy') page = <PrivacyPage />;
  else if (route.name === 'settings') {
    page = (
      <Suspense fallback={<p className="muted">Loading</p>}>
        <SettingsPage section={route.section} search={search} />
      </Suspense>
    );
  } else if (!config || route.name === 'not-found') page = <NotFound />;
  else if (route.name === 'overview') page = <OverviewPage config={config} />;
  else if (route.name === 'table') page = <TablePage key={config.slug} config={config} search={search} />;
  else page = <RecordPage key={route.id} config={config} id={route.id} />;

  const tabBar = phone && app && (route.name === 'overview' || route.name === 'table');
  const actionBar = phone && app && route.name === 'record';

  return (
    <ToastProvider>
      <div className={['site', tabBar && 'has-bottombar', actionBar && 'has-actionbar'].filter(Boolean).join(' ')}>
        <TopBar route={route} config={app} phone={phone} />
        <main className="site-main">
          <div key={pathname} className="screen">
            {page}
          </div>
        </main>
        <footer className="site-footer">
          <p>Data is CC BY 4.0, code is MIT. Every record links to the page it was checked against.</p>
          <p className="footer-end">
            <a className="built-on" href="https://manyfold.ai" target="_blank" rel="noopener noreferrer">
              Built on
              <ManyfoldMark />
              <b>Manyfold</b>
            </a>
            <span aria-hidden="true">·</span>
            <Link href="/privacy">Privacy</Link>
          </p>
        </footer>
        {tabBar ? <TabBar config={app} route={route} onContribute={() => setContributing(true)} /> : null}
        {app ? <ContributeSheet config={app} open={contributing} onClose={() => setContributing(false)} /> : null}
        {route.name === 'settings' ? null : <Consent />}
      </div>
    </ToastProvider>
  );
}
