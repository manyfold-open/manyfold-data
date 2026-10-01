/**
 * The consent banner. It appears only where consent is owed (the Worker answers from the
 * visitor's country at GET /api/consent), only on pages that carry the tag, and only until
 * the visitor answers. Decline and Accept are the same size and weight.
 *
 * Nothing here enforces privacy: by the time this renders, the tag has already denied
 * itself in every region that requires asking. This is how a visitor changes that.
 */

import { useEffect, useState } from 'react';
import { measuring, setConsent, storedConsent, type Consent as Choice } from '../analytics';
import { getJson } from '../api';
import { Link } from '../router';

export default function Consent() {
  const [answered, setAnswered] = useState(() => storedConsent() !== null);
  const [owed, setOwed] = useState(false);

  useEffect(() => {
    if (answered || !measuring()) return;
    const controller = new AbortController();
    getJson<{ required: boolean }>('/api/consent', controller.signal)
      .then((reply) => setOwed(reply.required))
      .catch(() => undefined);
    return () => controller.abort();
  }, [answered]);

  if (answered || !owed) return null;

  const answer = (choice: Choice) => {
    setConsent(choice);
    setAnswered(true);
  };

  return (
    <aside className="consent" aria-label="Analytics">
      <p>
        May we use Google Analytics to see which pages people use? Nothing is stored for it until you choose.{' '}
        <Link href="/privacy">Privacy</Link>
      </p>
      <div className="consent-answer">
        <button type="button" className="quiet-button" onClick={() => answer('denied')}>
          Decline
        </button>
        <button type="button" className="quiet-button" onClick={() => answer('granted')}>
          Accept
        </button>
      </div>
    </aside>
  );
}
