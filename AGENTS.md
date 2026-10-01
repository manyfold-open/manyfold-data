# Working on this repository

Rules for anyone — human or AI agent — changing Manyfold Data. These are the load-bearing walls.

## Invariants

1. **Only verified records are public.** Every read query filters on `status = 'verified'` (the record
   page also shows `stale`). Pending, rejected and merged records never appear in a public response.
2. **A data app is its config.** Pages, filters, charts and validation derive from
   `data-apps/<slug>/config.ts`. Do not special-case a slug in code; extend the config format in
   `src/shared/data-app.ts` instead, and teach `validateConfig()` the new rule.
3. **Field names reach SQL text only after validation.** `buildWhere()` interpolates field names that
   `parseQuery()` matched against the config; every value is a bound parameter. Keep it that way.
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
    the Google tag, consent defaults before the library; never tag `/settings`, the API, or a host other
    than `PUBLIC_ORIGIN`'s. Events (`src/app/analytics.ts`) carry the data app's slug and fixed values,
    never text a person typed. Tests use made-up ids like `G-TESTID0000`, never the real one, and
    `/privacy` must keep describing what the code does.

## Tests

`tests/d1.ts` is a D1 double on Node's built-in SQLite, so API tests run the Worker's real SQL. Use it
(with `app.request`) for any route that touches the database, and stub `fetch` for outside calls.

The reader UI builds its controls from `src/app/ui/`; `tests/native-controls.test.ts` fails on a native
select, checkbox, radio, date input or dialog anywhere else in the reader flow, and `tests/contrast.test.ts`
checks the color tokens in `src/app/styles.css`. Chart, filter and smart-filter logic lives in
`src/app/model/` as plain TypeScript, tested in `tests/reader-model.test.ts`.

## Checks

```bash
npm run check   # typecheck + build + wrangler deploy --dry-run
npm test        # vitest, including every config and seed record
```
