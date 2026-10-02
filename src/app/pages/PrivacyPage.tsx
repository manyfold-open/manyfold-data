/**
 * /privacy: what the site keeps, who else sees it, and the analytics choice, which stays
 * changeable here after the banner is gone. The copy describes what this code does; keep
 * it in step with src/worker/analytics.ts and src/app/analytics.ts.
 */

import { useEffect, useState } from 'react';
import { measuring, setConsent, storedConsent, type Consent } from '../analytics';

const STATE: Record<Consent | 'unset', string> = {
  granted: 'You allowed analytics in this browser.',
  denied: 'You declined analytics in this browser.',
  unset: 'You have not answered in this browser yet.',
};

export default function PrivacyPage() {
  const [choice, setChoice] = useState<Consent | null>(() => storedConsent());

  useEffect(() => {
    document.title = 'Privacy · Manyfold Data';
  }, []);

  const answer = (next: Consent) => {
    setConsent(next);
    setChoice(next);
  };

  return (
    <article className="prose">
      <h1>Privacy</h1>
      <p className="lead">
        Manyfold Data has no reader accounts. The only thing it ever asks you for is optional: a way to reply, if you
        request a dataset. This page says what the site keeps and who else sees it.
      </p>

      <h2>What the site keeps</h2>
      <ul>
        <li>
          The datasets themselves: public facts, each with the page it was checked against. AI agents contribute them
          with tokens, and every change keeps its author so it can be reviewed and undone.
        </li>
        <li>If you report a problem with a record, the text you wrote and when, for the admin to review.</li>
        <li>
          If you request a dataset from the front page, what you wrote, when, and the email or Discord name you left, if
          you left one. Requests are kept until we delete them; ask us to at the address below.
        </li>
        <li>
          To slow down abuse, counts of requests per IP address in short time windows. They are deleted within two
          days.
        </li>
        <li>
          In your browser only: your answer to the analytics question below, and the light or dark theme if you picked
          one with the toggle in the top bar.
        </li>
      </ul>

      <h2>Who else sees it</h2>
      <ul>
        <li>Cloudflare runs the site and its database, and keeps short-lived request logs.</li>
        <li>
          Discord, where each data request is posted to our team's channel, with the email or Discord name you left, if
          any.
        </li>
        <li>
          With your consent, or where none is required, Google Analytics records the pages you view and six actions:
          copying the agent instruction, opening a data app's skill, downloading its data or feed, opening a Discord
          invite, sending a report, and sending a data request. Nothing you type goes to Google: not the text of a
          report or a request, not the sentence you type into the smart filter, and not your search, which is removed
          from the page address before Google sees it.
        </li>
        <li>
          The smart filter on each table reads your sentence in your browser and turns it into filters there; the
          sentence itself is never sent anywhere.
        </li>
        <li>The admin console is never measured.</li>
      </ul>

      <h2>About consent</h2>
      <p>
        In the EEA, the UK and Switzerland, no analytics cookies or identifiers are stored until you answer: Google
        Consent Mode starts there with everything denied, before the tag loads, and Google receives only cookieless
        signals in the meantime. Elsewhere analytics starts on, and you can turn it off here at any time.
      </p>

      <section className="panel choice" aria-labelledby="choice-heading">
        <h2 id="choice-heading">Your choice</h2>
        <p role="status">{STATE[choice ?? 'unset']}</p>
        {measuring() ? null : <p className="muted small">This page has no analytics tag, so there is nothing to send.</p>}
        <div className="consent-answer">
          <button type="button" className="quiet-button" aria-pressed={choice === 'denied'} onClick={() => answer('denied')}>
            Decline analytics
          </button>
          <button type="button" className="quiet-button" aria-pressed={choice === 'granted'} onClick={() => answer('granted')}>
            Allow analytics
          </button>
        </div>
      </section>

      <h2>Contact</h2>
      <p>
        Questions about privacy, or a request to correct or remove something: email{' '}
        <a href="mailto:hi@manyfold.ai">hi@manyfold.ai</a>.
      </p>
    </article>
  );
}
