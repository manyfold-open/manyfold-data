# UI/UX redesign: reader flow

Status: implemented, all phases in one change (see the notes at the end). Mockup: [`ui-ux-mockup.html`](ui-ux-mockup.html) (open it in a
browser; it is self-contained and uses the live data of 1 October 2026).

## Scope

The reader flow of every data app, on desktop and phone: Catalog → Overview → Table → Record, plus the
contribute entry point. Out of scope: the `/settings` console, email (Resend) and any change to the API's
rules. The redesign must work for any data app from its config alone (AGENTS.md invariant 2), so AI Company
Fundraising and AI Hackathons share every component.

## Direction

A clean data product in the vein of TradingView: white canvas, 1px hairlines, gray pills, one blue, green for
growth. No gradients, glows or shadows except on popovers. Small type, because the data is the content.

| Token | Light | Dark | Use |
|---|---|---|---|
| `--bg` | `#ffffff` | `#0f0f0f` | page |
| `--hover` | `#f7f8fa` | `#191919` | row and option hover |
| `--chip` | `#f2f2f2` | `#242424` | pills, inputs, tags |
| `--line` / `--line2` | `#f0f0f0` / `#e0e3eb` | `#1f1f1f` / `#2e2e2e` | row dividers / section rules |
| `--ink` / `--ink2` / `--muted` | `#0f0f0f` / `#434651` / `#787b86` | `#ededed` / `#b2b5be` / `#8c8f99` | text |
| `--accent` | `#2962ff` | `#3a7bff` | links, selection, chart marks |
| `--up` | `#06806b` | `#22ab94` | growth, verified |
| `--warn` | `#b26b00` | `#e8a33d` | stale, low coverage |

- **Type:** Inter, self-hosted (Latin subset, `font-display: swap`). Scale: 12, 13, 14 (body and tables),
  16, 18 (numbers), 24 (page titles; 20 on phones). Tabular figures wherever digits line up. Amounts print the
  number with a small unit, e.g. `9.5 M USD`.
- **Theme:** follows the system, with a manual toggle stored per browser.
- **Chart color:** marks use `--accent`; parts of a whole use the same blue at falling opacity. Text never
  wears the accent. Re-run the contrast checks for marks (3:1) and text (4.5:1) after the change.
- **Logo:** a 5×5 grid of data cells; the filled cells spell M and the center cell is blue. Wordmark
  "Manyfold" with "Data" in muted gray. Replaces `public/favicon.svg` too. Distinct from the Manyfold app mark.

## Components: every control is our own

No browser-default control appears in the reader flow: no native `<select>`, checkbox, radio, date picker or
default focus ring. Controls live in `src/app/ui/`:

Button (primary, secondary) · filter Pill and radio Pill · Checkbox row (16px box, count on the right) ·
SearchField (clear button, `/` shortcut) · Textarea · Menu · Sheet (phone, drag to close) · Segmented
(Chart/Table) · Tag · removable Chip · chart Tooltip · Skeleton · Toast · data Table (sticky first column) ·
List row (phone) · Logo.

Guard: a Vitest test scans `src/app/**/*.tsx` outside `src/app/ui/` and fails on `<select`, `<dialog`,
`type="checkbox"`, `type="radio"` and `type="date"`. This needs no new dependency.

## Shell

- Desktop: top bar with logo, data app name, Overview / {noun} tabs (a sliding gray pill marks the current
  one) and the theme toggle. Global search (⌘K) is left out for now.
- Phone: top bar with back button and title; bottom tab bar with Overview, {noun} and Contribute.

## Overview: built from `config.charts` and `/stats`

No new API. Each chart kind maps to one treatment, and the same rules apply to every data app:

| Config chart | Treatment |
|---|---|
| `count` | First tile of the stat strip, with its share of all records. The strip continues with verified, waiting for review and last updated. |
| `over-time` | Weekly columns (the counts are discrete, so columns, not a line). The current week is solid. When the field looks forward (`accept.<field>.from = 'today'`, e.g. hackathon start dates), a Today line splits past from upcoming and later weeks are lighter. |
| `by-category`, ≤5 values, not tags | One proportion bar plus a legend with count and share (Region, Format). |
| `by-category`, >5 values or tags | Ranked bars, top 6 with "Show all N" (Round, Sector, Top cities). |
| `histogram` | Columns per bin, labeled by upper edge. When fewer than 60% of records state the value, a coverage line sits above the chart (only 16% of hackathons state a prize pool). |

Every chart also has:

- A one-line takeaway under the title, computed from the stats. Examples: "37 this week · busiest week
  Sep 14 (45)", "Top 3 make up 58% of rounds", "Only 16% of hackathons state a prize pool".
- A Chart / Table toggle. Table keeps today's accessible data table.
- Drill-down: clicking a bar or legend row opens the Table with that filter, using the existing query
  format, e.g. `?stage=seed` or `?amount_usd_from=…&amount_usd_to=…`.

Below the charts sit the preview (`table.previewTitle`, `table.previewColumns`) and the contribute strip with
the copyable agent instruction.

## Table: filter column

The structure follows Booking.com's filter list; the look follows the components above. Generated from the
config:

1. **Smart filter:** a sentence becomes filters. Version 1 is a deterministic parser built from the config's
   own labels: enum values, tag values, amounts like "$50M" and ranges like "next 7 days". It runs in the
   browser and never sends the text anywhere, which keeps analytics invariant 17 intact. A model-backed
   version can come later and must output the same `QueryState`.
2. **Popular:** the top value of each category field, one date preset and one amount threshold.
3. **One group per `enum` and `tags` field:** checkbox rows with live counts from the records response's
   `facets`, and "Show all" after 6.
4. **Date:** pills. The direction comes from `accept` (past for fundraising, upcoming for hackathons).
5. **Amount:** pills built from the histogram's edges, plus a custom range when the user arrives from a
   histogram bin.

The desktop column is sticky and scrolls on its own; it needs side padding so hover and focus states are not
clipped. Applied filters also show as removable chips above the results.

The results table shows `table.columns`, keeps the first column sticky and scrolls the rest horizontally;
long text truncates with a tooltip. On a phone the table becomes list rows (title, first enum value and city,
then the number or date on the right) with a filter sheet and a sort sheet. Filters, sort and page stay in the
URL as today.

## Record

- **Header:** initials avatar, title, status (Verified with date, or May be out of date), enum tags and the
  subtitle field. Leave 14px between the title and the tag row (12px on phones).
- **Details:** a grid of every other field. URLs are links, tags are chips, amounts carry their unit.
- **Source:** link, the quote, the time it was read, and Report a problem.
- **History:** the record's revisions.
- **Phone:** order is source, then details, then history; the bottom bar holds Open source and Report.

## Loading and motion

- Skeletons match the final layout (target CLS 0). They show only after 150ms and stay at least 300ms.
- When the data refetches, the old results stay on screen with a 2px progress line above them.
- Motion lasts 120–300ms and animates transform and opacity only: screen fade, tab pill slide, bars that grow
  once on first view, sheet and menu transitions.
- `prefers-reduced-motion` turns all of it off.
- No animation library is added.

## Invariants touched

- **2, config drives everything:** no slug checks. Treatments come from chart kind, field type and `accept`.
- **1, only verified records are public:** no new public routes. Everything reads `/stats` and `/records`.
- **17, analytics:** new interactions (drill-down, Chart/Table toggle, smart filter) may be tracked only with
  fixed values and the slug, never typed text.
- **6, runtime split:** shared helpers stay importable from plain Node.
- Every phase ends with `npm run check` and `npm test` green. A merge to main deploys.

## Phases (one PR each, each deployable)

| Phase | Contents | Done when |
|---|---|---|
| P0 Foundation | Tokens, Inter, `src/app/ui/` kit, logo and favicon, native-control guard test, theme toggle | Pages restyled, layout unchanged, checks green |
| P1 Shell, Catalog, Overview | Top bar and tabs, phone tab bar, chart treatments, takeaways, Chart/Table, drill-down, skeletons | Both data apps render from config; CLS 0 |
| P2 Table | Filter column, chips, sticky-column table, load more, phone list and sheets | URL round-trips every filter; counts match facets |
| P3 Record | Header, details grid, source, history, phone order and action bar | Works for both apps; stale state shown |
| P4 Smart filter and polish | Parser, reduced-motion pass, contrast checks, screenshots at 1440, 1024, 390 and 360 | Lighthouse accessibility ≥ 95 |

## Decided

- **Direction:** the TradingView-style clean version, replacing the earlier Linear and soft-gradient explorations.
- **Theme:** system plus manual toggle.
- **Animation library:** none (no GSAP or Motion).
- **Font:** Inter, self-hosted.
- **Config format:** no change needed for v1; the phone list derives its fields from `table.columns`.

## Implementation notes

- Pure helpers live in `src/app/model/`: `charts.ts` (treatment per chart, takeaways), `drill.ts` (chart to
  Table links), `filters.ts` (date and amount pills, Popular, chips, sort options) and `smart-filter.ts`. They
  import no DOM or React, and `tests/reader-model.test.ts` runs them in Node for both data apps.
- The native-control guard (`tests/native-controls.test.ts`) also exempts `src/app/settings/`: the console is
  out of scope and keeps its plain form controls. Its styles moved to `src/app/settings/settings.css`, which
  ships only in the console's chunk.
- `tests/contrast.test.ts` reads the token blocks in `src/app/styles.css`. To pass 4.5:1 on every surface,
  light `--muted` is `#6a6d78`, `--warn` `#9a5c00` and `--up` `#057866` (the table above lists the starting
  values). Primary buttons use `--btn` (`#2962ff` in both themes) so white text keeps 4.5:1 in dark.
- Load more keeps `page` in the URL as the number of pages shown, so a shared link opens the same rows.
- Histogram drill-down ranges stop one below the next edge (`amount_usd_to=24999999`), because bins are
  half-open and the Table's ranges are inclusive.
- The top bar also holds an icon-only Discord button (`DISCORD_URL` in `src/app/site.ts`), tracked as
  `discord_joined` with `placement: 'header'`.
