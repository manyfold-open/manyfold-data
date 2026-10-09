# Working on this repository

Rules for anyone — human or AI agent — changing Manyfold Data. These are the load-bearing walls.

## Invariants

1. **Only verified records are public.** Every read query filters on `status = 'verified'` (the record
   page also shows `stale`). Pending, rejected and merged records never appear in a public response.
2. **A data app is its config.** Pages, filters, charts and validation derive from
   `data-apps/<slug>/config.ts`. Do not special-case a slug in code; extend the config format in
   `src/shared/data-app.ts` instead, and teach `validateConfig()` the new rule.
3. **No field name reaches SQL text.** The Table's queries run in memory over the dataset
   (`src/shared/engine.ts`), and every value in the SQL that remains is a bound parameter. Keep it that way.
4. **Evolve the database only through `SCHEMA` in `src/worker/schema.ts`**, with
   `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS`. No semicolons inside statement bodies
   or comments — the splitter treats every `;` as a boundary. There is no migration step.
5. **Every change to a record is a revision.** Never `UPDATE records` without inserting the matching
   `revisions` row; revert-by-token depends on it.
6. **Respect the runtime split.** `src/worker/` runs in workerd, `src/app/` in the browser,
   `src/shared/` and `data-apps/` in both and in plain `node` (the seed scripts). Files under
   `src/shared/` and `data-apps/` import each other with explicit `.ts` extensions and use only
   type syntax Node can strip (no enums, namespaces or parameter properties).
7. **Keep `GET /api/health` returning 200 JSON.** The deploy workflow checks it.
8. **Never commit secrets.** The Discord webhook URL and every token belong in `/settings` or
   `wrangler secret`, never in the repo.
9. **Seed records are checked facts.** Each needs a source page and a quote copied word for word from
   it. Run `npm run seed:verify` after changing a seed; check a draft first with
   `npm run seed:verify -- --app <slug> --file draft.json`.
10. **`/join` only ever creates collector tokens.** No public route may create or promote a maintainer
    token. Token secrets are shown once and stored only as SHA-256; never log or return them again.
11. **Only maintainers' verdicts (`src/worker/maintainer.ts`) and the admin (`src/worker/console.ts`)
    change a record's status** (and the seed, for new records). A verdict counts only for a task leased
    to the token sending it, while the lease lasts, never for a record that token submitted. Every status
    or data change writes a revision with the record before and after; undo by token reads nothing else.
    A page a maintainer could not read is `unsure` (`cannot_open`), never grounds to reject or mark stale:
    `couldNotRead` refuses such verdicts. On 2026-10-01 a blocked wire service cost ten real records that
    way. Pages it could read that do not support the record are grounds to reject.
12. **The admin API stays closed by default.** `/api/admin/*` refuses everything until `ADMIN_PASSWORD`
    is set, compares it in constant time, and never returns a token secret except once, at issue.
13. **Agent-facing text comes from the config.** `src/worker/skill.ts` builds both skills from it. When
    the API's rules change, change the skill text in the same commit, and keep every error message
    specific enough for an agent to fix its request.
14. **Webhook URLs are stored sealed.** `src/worker/notify.ts` seals them with `CONFIG_ENCRYPTION_KEY`
    (AES-GCM) and only ever returns the masked form. Posts set `allowed_mentions: {parse: []}`,
    suppress link previews, and escape everything contributors wrote. Never rotate the key in production.
15. **`/api/admin/*` sends no CORS headers**, so no other site can call it from a browser; the console
    is same-origin. Public read routes stay open to any origin.
16. **Exports are spreadsheet-safe.** The CSV writer prefixes cells that start with `=`, `+`, `-` or `@`
    so a contributor's text never runs as a formula; keep that guard on every new export.
17. **Analytics is consent-first and stays out of the console.** Only `src/worker/analytics.ts` writes
    the Google tag, consent defaults before the library; one answer covers analytics and ad measurement,
    and `ad_personalization` is never granted; never tag `/settings`, the API, or a host other
    than `PUBLIC_ORIGIN`'s. Events (`src/app/analytics.ts`) carry the data app's slug and fixed values,
    never text a person typed; page views carry `page_location` without `TYPED_PARAMS` (the search). Tests use made-up ids like `G-TESTID0000`, never the real one, and
    `/privacy` must keep describing what the code does.
18. **Readers cost the database a row or two, not a scan.** Each data app's public dataset is stored in
    `dataset_parts`, cut under D1's 2 MB row limit, and read as those rows (`datasetJson`,
    src/worker/records.ts). Only `buildDataset` scans an app's verified records: when nothing is stored,
    and once a UTC day. In between, `refreshDatasets` (the cron, before Discord posts, and
    `refreshesDatasets` in src/worker/index.ts after an admin change) merges in the records whose
    `updated_at` moved since it last looked. The Table, the Overview and the /records and /stats routes
    are computed from the dataset by `src/shared/engine.ts`, in the browser and the Worker alike, and the
    catalog reads the totals in `dataset_heads`. A new public view is computed from the dataset, never
    from new SQL over records; a new write path keeps moving `records.updated_at`, which is what a refresh
    reads, and anything that writes records with an older `updated_at` (the seed) drops the heads so the
    next run builds whole. Public reads are cached with `cachedFor`/`cachedJson` (src/worker/cache.ts),
    and nothing else is: never cache a route that reads a token, the admin password or a visitor's
    country. D1's free tier caps reads a day for the whole account and counts every row a query steps
    through, index entries included; see "Database budget" in the README. A query on a hot path (an
    agent call, the cron) reads what it needs through an index, never a table's history:
    `tests/budget.test.ts` holds the busiest ones to a budget on real D1, and a new one goes there too.
19. **Data requests come from this site only, and reach people only through the cron.**
    `POST /api/requests` refuses a browser `Origin` other than its own: CORS alone does not stop a
    cross-site POST, and every visitor of such a page would bring a new IP. It counts the site's daily
    bound only after the per-IP limit and the check pass, so one address cannot close the form for
    everyone. The cron posts requests (`src/worker/requests.ts`) escaped, each line starting with our
    own text, and marks only what Discord accepted as sent.
20. **A token's standing is one row, moved with every status change.** `standings` keeps each token's
    verified, rejected, merged and stale records per data app; GET /me, the skill, submit and suspension
    read it, and count only the token's pending records live. Every statement that changes a record's
    status has `moveStanding` (src/worker/tokens.ts) before it in the same batch, with the same status
    guard, so the counts move exactly when the record does. A row a day old is counted again from the
    records, which mends a change made by hand in the database within a day.
21. **Doubt goes to whoever can settle it, and only then to people.** An `unsure` verdict names why
    (`unsure_type`): a page others cannot open goes to a maintainer of that data app with a browser (a
    token capability), and the server reads the page itself first; a duplicate of a record still waiting
    is parked until that one is decided (`src/worker/waits.ts`); sources in conflict go to a second
    maintainer. Only what those cannot settle, questions the rules do not answer, and a day's wait for a
    browser reach the admin, at most `HUMAN_DAILY_MAX` a day per token. Handing on is a `defer` revision,
    sending to the admin an `unsure` one, and neither shows in a record's public history. A token never
    gets a task again for a record it could not decide, and records waiting for the admin do not count
    against their collector's cap. Every writer of a record's status (verdicts, decisions, bans) lets the
    records parked on it follow (`resolveWaiting`) in the same batch.
22. **Agents work from the rules as they are.** Leases, verdicts and submits carry `X-Skill-Version`, a
    hash of the instructions the agent read for that data app and role (`skillVersion` in
    `src/worker/skill.ts`), which changes whenever the rules or the app's config do. A missing one is
    refused on maintainers' leases and verdicts and warned about on submits; an old one is refused for
    anyone. No error ever says the current version: an agent learns it by reading the instructions.
    Giving tasks back (`POST /api/<slug>/tasks/release`) never needs one.
23. **Maintainers answer for their verdicts as collectors do for their records.** The admin's later
    decisions on a record, and spot checks marking it wrong, count against the maintainer whose verdict
    they overturn (`maintainerQuality`, src/worker/tokens.ts); a maintainer with more than half of 10 or
    more overturned is suspended. Quality is read for the console and after the admin's decisions, never
    on an agent's call. A decision of the admin's that states a rule is kept as a precedent until the rule
    is written into the data app's config.

## Tests

`tests/d1.ts` is a D1 double on Node's built-in SQLite, so API tests run the Worker's real SQL. Use it
(with `app.request`) for any route that touches the database, and stub `fetch` for outside calls.

`tests/budget.test.ts` runs the busiest statements on workerd's own D1 (`tests/workerd.mjs`, through
wrangler's `getPlatformProxy`), which reports rows read the way production bills them, at production's
sizes. When a change makes an agent call, a reader's read or the cron read more, a budget there fails.

The reader UI builds its controls from `src/app/ui/`; `tests/native-controls.test.ts` fails on a native
select, checkbox, radio, date input or dialog anywhere else in the reader flow, and `tests/contrast.test.ts`
checks the color tokens in `src/app/styles.css`. Chart, filter and smart-filter logic lives in
`src/app/model/` as plain TypeScript, tested in `tests/reader-model.test.ts`.

## Checks

```bash
npm run check   # typecheck + build + wrangler deploy --dry-run
npm test        # vitest, including every config and seed record
```
