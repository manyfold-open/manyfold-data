import { useState } from 'react';
import type { ActivityItem } from '../../shared/types';
import { useAdmin } from './adminApi';
import { Notice, When } from './ui';

/** The latest changes to any record, newest first; filter to one actor by clicking it. */
export default function ActivitySection({ slug, onOpen }: { slug: string; onOpen: (id: string) => void }) {
  const [actor, setActor] = useState<{ id: string; label: string } | null>(null);
  const params = new URLSearchParams({ app: slug, ...(actor ? { actor: actor.id } : {}) });
  const { data, error } = useAdmin<{ items: ActivityItem[] }>(`/activity?${params}`);

  return (
    <>
      <div className="section-head">
        <h2>Activity</h2>
        {actor ? (
          <button type="button" className="quiet-button" onClick={() => setActor(null)}>
            Showing {actor.label} only · show everyone
          </button>
        ) : (
          <span className="muted">Latest 100 changes</span>
        )}
      </div>
      <Notice error={error} />
      <div className="table-wrap">
        <table className="records">
          <thead>
            <tr>
              <th scope="col">When</th>
              <th scope="col">Change</th>
              <th scope="col">By</th>
              <th scope="col">Record</th>
              <th scope="col">Reason</th>
            </tr>
          </thead>
          <tbody>
            {(data?.items ?? []).map((item) => (
              <tr key={item.id}>
                <td>
                  <When at={item.created_at} />
                </td>
                <td>{item.action}</td>
                <td>
                  <button type="button" className="link-button" onClick={() => setActor(item.actor)}>
                    {item.actor.label}
                  </button>
                </td>
                <td className="wrap">
                  <button type="button" className="link-button" onClick={() => onOpen(item.record_id)}>
                    {item.record_name}
                  </button>
                </td>
                <td className="wrap">{item.reason ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
