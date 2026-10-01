/**
 * The frame around every page. Desktop: a top bar with the logo, the data app's name, its
 * Overview and {noun} tabs (a gray pill slides to the current one), Discord and the theme
 * toggle. Phone: a top bar with Back and the page's title, and a tab bar at the bottom.
 */

import { useLayoutEffect, useRef, useState } from 'react';
import type { DataAppConfig } from '../../shared/data-app';
import { track } from '../analytics';
import { nounTitle } from '../format';
import { tableHrefFor } from '../memory';
import { Link } from '../router';
import type { Route } from '../routes';
import { DISCORD_URL } from '../site';
import { useTheme } from '../theme';
import { Icon, IconButton, Logo, Tooltip } from '../ui';

/** Opens the Manyfold Discord in a new tab. Tracked with fixed values only. */
export function DiscordButton({ slug }: { slug?: string }) {
  return (
    <Tooltip text="Join our Discord" repeatsLabel>
      {() => (
        <a
          className="icon-button"
          href={DISCORD_URL}
          target="_blank"
          rel="noopener noreferrer"
          aria-label="Join our Discord"
          onClick={() => track('discord_joined', { data_app: slug ?? 'site', placement: 'header' })}
        >
          <Icon name="discord" size={18} />
        </a>
      )}
    </Tooltip>
  );
}

export function ThemeToggle() {
  const [theme, toggle] = useTheme();
  const label = theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme';
  return <IconButton icon={theme === 'dark' ? 'sun' : 'moon'} label={label} onClick={toggle} end />;
}

function Tabs({ config, route }: { config: DataAppConfig; route: Route }) {
  const nav = useRef<HTMLElement>(null);
  const [pill, setPill] = useState<{ x: number; width: number; animate: boolean } | null>(null);
  const onTable = route.name === 'table' || route.name === 'record';
  const current = route.name === 'overview' ? 0 : onTable ? 1 : -1;

  useLayoutEffect(() => {
    const link = nav.current?.querySelectorAll<HTMLElement>('a')[current];
    if (!link) {
      setPill(null);
      return;
    }
    const measure = (animate: boolean) => setPill({ x: link.offsetLeft, width: link.offsetWidth, animate });
    setPill((previous) => ({ x: link.offsetLeft, width: link.offsetWidth, animate: previous !== null }));
    // Inter may swap in after the first measure and change the width.
    void document.fonts?.ready.then(() => measure(false));
  }, [current]);

  return (
    <nav ref={nav} className="tabs" aria-label={config.title}>
      {pill ? (
        <span
          className="tabs-pill"
          aria-hidden="true"
          style={{ width: pill.width, transform: `translateX(${pill.x}px)`, transition: pill.animate ? undefined : 'none' }}
        />
      ) : null}
      <Link href={`/${config.slug}`} aria-current={route.name === 'overview' ? 'page' : undefined}>
        Overview
      </Link>
      <Link href={tableHrefFor(config.slug)} aria-current={route.name === 'table' ? 'page' : undefined}>
        {nounTitle(config)}
      </Link>
    </nav>
  );
}

const Brand = () => (
  <Link href="/" className="brand" aria-label="Manyfold Data: all data apps">
    <Logo />
  </Link>
);

export function TopBar({ route, config, phone }: { route: Route; config: DataAppConfig | undefined; phone: boolean }) {
  const end = (
    <>
      <DiscordButton slug={config?.slug} />
      <ThemeToggle />
    </>
  );

  if (phone) {
    const back =
      config && route.name === 'record'
        ? { href: tableHrefFor(config.slug), label: `Back to ${config.noun.other}`, title: capitalOne(config) }
        : config && route.name === 'table'
          ? { href: `/${config.slug}`, label: `Back to ${config.title}`, title: nounTitle(config) }
          : config && route.name === 'overview'
            ? { href: '/', label: 'Back to all data apps', title: config.title }
            : null;
    return (
      <header className="topbar">
        <div className="topbar-inner">
          {back ? (
            <>
              <Link href={back.href} className="icon-button" aria-label={back.label}>
                <Icon name="back" size={20} />
              </Link>
              <span className="topbar-title">{back.title}</span>
            </>
          ) : (
            <Brand />
          )}
          {end}
        </div>
      </header>
    );
  }

  return (
    <header className="topbar">
      <div className="topbar-inner">
        <Brand />
        {config ? <span className="topbar-app">{config.title}</span> : null}
        {config ? <Tabs config={config} route={route} /> : null}
        <span className="grow" />
        {end}
      </div>
    </header>
  );
}

const capitalOne = (config: DataAppConfig): string => config.noun.one.charAt(0).toUpperCase() + config.noun.one.slice(1);

/** The phone's tab bar on Overview and Table: Overview, {noun}, Contribute. */
export function TabBar({ config, route, onContribute }: { config: DataAppConfig; route: Route; onContribute: () => void }) {
  return (
    <nav className="bottombar" aria-label={config.title}>
      <div className="tabbar">
        <Link href={`/${config.slug}`} aria-current={route.name === 'overview' ? 'page' : undefined}>
          <Icon name="chart" size={22} />
          Overview
        </Link>
        <Link href={tableHrefFor(config.slug)} aria-current={route.name === 'table' ? 'page' : undefined}>
          <Icon name="list" size={22} />
          {nounTitle(config)}
        </Link>
        <button type="button" onClick={onContribute} aria-haspopup="dialog">
          <Icon name="bot" size={22} />
          Contribute
        </button>
      </div>
    </nav>
  );
}
