#!/usr/bin/env python3
"""Manyfold Data lookups for the guide agent.

Read-only: every call is a GET to data.manyfold.ai's public API. Prints short
plain text meant to be read by the agent, with each record's page link.

  python3 mfd.py apps                                   every dataset, its record count and last update
  python3 mfd.py fields <slug>                          the fields of one dataset and how to filter them
  python3 mfd.py search <slug> [--q TEXT] [--is F=v1,v2] [--from F=V] [--to F=V] [--sort F | --desc F] [--limit N] [--page N]
  python3 mfd.py record <slug> <id>                     one record with its source and the quote it was checked against
  python3 mfd.py stats <slug>                           the dataset's overview figures
  python3 mfd.py find <text>                            the text across every dataset
  python3 mfd.py updates [--mark] [--limit N]           newly verified high-signal records

Dates are YYYY-MM-DD, or "today".
"""

import argparse
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

BASE = 'https://data.manyfold.ai'
CACHE = os.path.expanduser('~/.cache/mfd')
UA = 'manyfold-data-guide-agent (Manyfold)'
DATE = re.compile(r'^\d{4}-\d{2}-\d{2}$')
HIGH_SIGNAL_SLUGS = ('visa-changes', 'new-rules', 'recalls', 'ai-hackathons', 'ai-fundraising')


def get(path, params=None, timeout=20):
    url = BASE + path + ('?' + urllib.parse.urlencode(params, doseq=True) if params else '')
    req = urllib.request.Request(url, headers={'User-Agent': UA, 'Accept': 'application/json'})
    with urllib.request.urlopen(req, timeout=timeout) as res:
        return json.load(res)


def cached(name, path, params, ttl):
    file = os.path.join(CACHE, name)
    try:
        if time.time() - os.path.getmtime(file) < ttl:
            with open(file) as f:
                return json.load(f)
    except (OSError, ValueError):
        pass
    data = get(path, params)
    os.makedirs(CACHE, exist_ok=True)
    tmp = file + '.tmp'
    with open(tmp, 'w') as f:
        json.dump(data, f)
    os.replace(tmp, file)
    return data


def apps():
    return cached('apps.json', '/api/apps', None, 600)['apps']


def app(slug):
    found = next((a for a in apps() if a['slug'] == slug), None)
    if not found:
        sys.exit(f'no dataset "{slug}": run apps for the list')
    return found


def link(slug, rid):
    return f'{BASE}/{slug}/r/{rid}'


# The API does not publish a dataset's field definitions, so they are read off
# its records: the facets name the filterable fields and their values, and the
# values show which fields are dates or numbers (the ones with _from/_to).
def schema(slug):
    sample = cached(f'{slug}.sample.json', f'/api/{slug}/records', {'limit': 100}, 3600)
    kinds = {}
    for rec in sample.get('records') or []:
        for key, value in (rec.get('data') or {}).items():
            if value is None or value == '' or value == []:
                continue
            if isinstance(value, bool):
                kind = 'yes/no'
            elif isinstance(value, (int, float)):
                kind = 'number'
            elif isinstance(value, list):
                kind = 'list'
            elif isinstance(value, str) and DATE.match(value):
                kind = 'date'
            elif isinstance(value, str) and value.startswith('http'):
                kind = 'url'
            else:
                kind = 'text'
            kinds.setdefault(key, kind)
    return kinds, sample.get('facets') or {}


def show(value):
    if isinstance(value, list):
        return ', '.join(str(v) for v in value)
    if isinstance(value, float) and value.is_integer():
        value = int(value)
    if isinstance(value, int) and value >= 10000:
        return f'{value:,}'
    return str(value)


def row(slug, rec):
    data = rec.get('data') or {}
    parts = [f'{k}: {show(v)}' for k, v in data.items() if v not in (None, '', []) and not str(v).startswith('http')]
    return f"- {' | '.join(parts)}\n  {link(slug, rec['id'])}"


def cmd_apps(args):
    for a in apps():
        print(f"- {a['slug']}: {a['title']}: {a['description']} ({a['verified']} records, updated {a['lastUpdated'][:10]})\n  {BASE}/{a['slug']}")


def cmd_fields(args):
    a = app(args.slug)
    kinds, facets = schema(args.slug)
    print(f"{a['title']} ({a['slug']}): {a['description']}")
    for key, kind in kinds.items():
        line = f'- {key} ({kind})'
        if key in facets:
            values = facets[key]
            top = ', '.join(f"{v['value']} ({v['count']})" for v in values[:15])
            more = f', … {len(values) - 15} more' if len(values) > 15 else ''
            line += f': filter with --is {key}=<values>; values: {top}{more}'
        elif kind in ('date', 'number'):
            line += f': range with --from {key}=… / --to {key}=…'
        print(line)
    print('Text search with --q covers every text field. Sort with --sort <field>, or --desc <field> for largest or latest first.')


def pairs(items, flag):
    out = {}
    for item in items or []:
        if '=' not in item:
            sys.exit(f'{flag} takes field=value, got "{item}"')
        key, value = item.split('=', 1)
        out[key.strip()] = value.strip()
    return out


def cmd_search(args):
    a = app(args.slug)
    params = {'limit': args.limit, 'page': args.page, 'facets': 'none'}
    if args.q:
        params['q'] = args.q
    for key, value in pairs(args.is_, '--is').items():
        params[key] = value
    for key, value in pairs(args.from_, '--from').items():
        params[f'{key}_from'] = value
    for key, value in pairs(args.to, '--to').items():
        params[f'{key}_to'] = value
    if args.desc:
        params['sort'] = f'-{args.desc}'
    elif args.sort:
        params['sort'] = args.sort
    try:
        res = get(f'/api/{args.slug}/records', params)
    except urllib.error.HTTPError as err:
        body = err.read().decode('utf-8', 'replace')[:400]
        sys.exit(f'the API refused that query ({err.code}): {body}. Run fields {args.slug} for what it accepts')
    total = res.get('total', 0)
    shown = res.get('records') or []
    print(f"{a['title']}: {total} records match (today is {res.get('today')}); page {res.get('page')}, showing {len(shown)}")
    for rec in shown:
        print(row(args.slug, rec))
    if total > args.page * args.limit:
        print(f'… more with --page {args.page + 1}')


def cmd_record(args):
    res = get(f'/api/{args.slug}/records/{urllib.parse.quote(args.id)}')
    rec = res.get('record') or res
    print(f"{app(args.slug)['title']} record {rec['id']}")
    for key, value in (rec.get('data') or {}).items():
        if value not in (None, '', []):
            print(f'{key}: {show(value)}')
    print(f"Source: {rec.get('source_url')}")
    if rec.get('evidence'):
        print(f"Quote from the source: \"{rec['evidence']}\"")
    print(f"Checked against the source on {(rec.get('verified_at') or '')[:10]} (page read {(rec.get('observed_at') or '')[:10]})")
    print(f"Page: {link(args.slug, rec['id'])}")


def cmd_stats(args):
    res = get(f'/api/{args.slug}/stats')
    tiles = res.get('tiles') or {}
    print(f"{app(args.slug)['title']} (today {res.get('today')}): {tiles.get('verified')} verified, {tiles.get('addedLast7Days')} added in the last 7 days, {tiles.get('pending')} waiting for review")
    for chart in res.get('charts') or []:
        title = chart.get('title')
        if chart.get('kind') == 'count':
            print(f"- {title}: {chart.get('value')}")
        elif chart.get('points'):
            recent = chart['points'][-8:]
            print(f"- {title} ({chart.get('bucket')}s from): " + ', '.join(f"{p.get('start')} ({p.get('count')})" for p in recent))
        elif chart.get('bars'):
            print(f"- {title}: " + ', '.join(f"{b.get('value')} ({b.get('count')})" for b in chart['bars'][:10]))
        elif chart.get('bins'):
            span = lambda b: f"{show(b.get('from'))}–{show(b['to'])}" if b.get('to') is not None else f"{show(b.get('from'))} and up"
            bins = ', '.join(f"{span(b)} ({b.get('count')})" for b in chart['bins'])
            print(f"- {title}: {bins}; {chart.get('missing', 0)} without a figure")
        else:
            print(f"- {title}")


def cmd_find(args):
    q = ' '.join(args.text)
    hits = 0
    for a in apps():
        try:
            res = get(f"/api/{a['slug']}/records", {'q': q, 'limit': args.limit, 'facets': 'none'})
        except urllib.error.HTTPError:
            continue
        if res.get('total'):
            hits += 1
            print(f"{a['title']} ({a['slug']}): {res['total']} records")
            for rec in res.get('records') or []:
                print(row(a['slug'], rec))
    if not hits:
        print(f'Nothing in any dataset mentions "{q}".')


def _load_announced(path):
    try:
        with open(path) as f:
            data = json.load(f)
        return data if isinstance(data, dict) else None
    except (OSError, ValueError):
        return None


def _save_announced(path, payload):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + '.tmp'
    with open(tmp, 'w') as f:
        json.dump(payload, f)
    os.replace(tmp, path)


def _is_upcoming_hackathon(rec, today):
    data = rec.get('data') or {}
    bound = str(data.get('deadline') or data.get('starts_on') or '')
    return not bound or bound >= today


def select_new_records(slug, records, today, prev_app_state, seen_ids):
    """Return newly verified records for one dataset plus its latest timestamp state."""
    prev_verified = (prev_app_state or {}).get('last_verified') or ''
    prev_at_ids = set((prev_app_state or {}).get('at_last_ids') or [])
    fresh = []
    max_ts = prev_verified
    all_ts = []
    for rec in records:
        if rec.get('status') not in (None, 'verified'):
            continue
        ts = rec.get('verified_at') or rec.get('updated_at') or ''
        if not ts:
            continue
        all_ts.append((ts, rec['id']))
        if ts > max_ts:
            max_ts = ts
        if rec['id'] in seen_ids:
            continue
        if slug == 'ai-hackathons' and not _is_upcoming_hackathon(rec, today):
            continue
        if prev_app_state is None or not prev_verified:
            fresh.append((ts, rec))
        elif ts > prev_verified or (ts == prev_verified and rec['id'] not in prev_at_ids):
            fresh.append((ts, rec))
    at_max = [rid for ts, rid in all_ts if max_ts and ts == max_ts]
    return fresh, max_ts, at_max


def cmd_updates(args):
    state_path = os.path.join(CACHE, 'last-announced.json')
    state = _load_announced(state_path)
    state_apps = (state or {}).get('apps') or {}
    seen_ids = set((state or {}).get('seen_ids') or [])

    all_apps = get('/api/apps').get('apps') or []
    by_slug = {a['slug']: a for a in all_apps}
    target_slugs = [s.strip() for s in args.slugs.split(',') if s.strip()] if args.slugs else list(HIGH_SIGNAL_SLUGS)

    candidates = []
    new_apps_state = dict(state_apps)
    for slug in target_slugs:
        meta = by_slug.get(slug)
        if not meta:
            continue
        app_updated = meta.get('lastUpdated') or ''
        prev = state_apps.get(slug)
        if state is not None and prev and app_updated and app_updated <= (prev.get('app_last_updated') or ''):
            continue
        if meta.get('verified', 0) <= 1000:
            ds = get(f'/api/{slug}/dataset')
        else:
            ds = get(f'/api/{slug}/records', {'limit': 100, 'facets': 'none'})
        today = ds.get('today') or time.strftime('%Y-%m-%d', time.gmtime())
        recs = ds.get('records') or []
        fresh, max_ts, at_max = select_new_records(slug, recs, today, prev if state is not None else None, seen_ids)
        for ts, rec in fresh:
            candidates.append((ts, slug, meta.get('title') or slug, rec, today))
        new_apps_state[slug] = {
            'app_last_updated': app_updated,
            'last_verified': max_ts,
            'at_last_ids': at_max,
        }

    candidates.sort(key=lambda item: (item[0], item[3]['id']), reverse=True)
    shown = candidates[: args.limit]
    if not shown:
        print('NO_UPDATES')
    else:
        today_str = shown[0][4]
        print(f'High-signal verified updates (today is {today_str}, {len(shown)} shown, newest first):')
        for ts, slug, title, rec, _today in shown:
            print(f'[{title} ({slug}) | verified {ts[:10]}]')
            print(row(slug, rec))

    if args.mark:
        prev_seen = list((state or {}).get('seen_ids') or [])
        new_seen = list(dict.fromkeys([item[3]['id'] for item in shown] + prev_seen))[:500]
        _save_announced(
            state_path,
            {
                'apps': new_apps_state,
                'seen_ids': new_seen,
                'marked_at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
            },
        )


def main():
    ap = argparse.ArgumentParser(description='Manyfold Data lookups')
    sub = ap.add_subparsers(dest='cmd', required=True)
    sub.add_parser('apps').set_defaults(fn=cmd_apps)

    s = sub.add_parser('fields')
    s.add_argument('slug')
    s.set_defaults(fn=cmd_fields)

    s = sub.add_parser('search')
    s.add_argument('slug')
    s.add_argument('--q')
    s.add_argument('--is', dest='is_', action='append', metavar='FIELD=v1,v2')
    s.add_argument('--from', dest='from_', action='append', metavar='FIELD=VALUE')
    s.add_argument('--to', action='append', metavar='FIELD=VALUE')
    s.add_argument('--sort', metavar='FIELD', help='ascending; --desc FIELD for descending')
    s.add_argument('--desc', metavar='FIELD')
    s.add_argument('--limit', type=int, default=8)
    s.add_argument('--page', type=int, default=1)
    s.set_defaults(fn=cmd_search)

    s = sub.add_parser('record')
    s.add_argument('slug')
    s.add_argument('id')
    s.set_defaults(fn=cmd_record)

    s = sub.add_parser('stats')
    s.add_argument('slug')
    s.set_defaults(fn=cmd_stats)

    s = sub.add_parser('find')
    s.add_argument('text', nargs='+')
    s.add_argument('--limit', type=int, default=3)
    s.set_defaults(fn=cmd_find)

    s = sub.add_parser('updates')
    s.add_argument('--mark', action='store_true', help='record announced watermark')
    s.add_argument('--limit', type=int, default=3)
    s.add_argument('--slugs', help='comma-separated dataset slugs to check')
    s.set_defaults(fn=cmd_updates)

    args = ap.parse_args()
    try:
        args.fn(args)
    except urllib.error.URLError as err:
        sys.exit(f'Manyfold Data did not answer ({err}); say the data is unreachable right now')


if __name__ == '__main__':
    main()
