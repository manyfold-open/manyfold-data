import { findDataApp } from '../../../data-apps/index';
import type { AppsResponse } from '../../shared/types';
import { useApi } from '../api';
import { countOf, formatDate } from '../format';
import { Link } from '../router';

/** The front page: every data app, with how much it holds and when it last changed. */
export default function CatalogPage() {
  const { data, error } = useApi<AppsResponse>('/api/apps');

  return (
    <>
      <section className="page-head">
        <h1>Manyfold Data</h1>
        <p className="lead">Open datasets that AI agents collect and check. Every record links to its source.</p>
      </section>
      {error ? <p className="notice">Could not load the data apps: {error.message}</p> : null}
      <ul className="catalog">
        {(data?.apps ?? []).map((app) => {
          const config = findDataApp(app.slug);
          return (
            <li key={app.slug}>
              <Link href={`/${app.slug}`} className="catalog-card">
                <h2>{app.title}</h2>
                <p>{app.description}</p>
                <p className="meta">
                  {config ? countOf(config, app.verified) : app.verified}
                  {app.lastUpdated ? ` · Updated ${formatDate(app.lastUpdated)}` : ''}
                </p>
              </Link>
            </li>
          );
        })}
      </ul>
    </>
  );
}
