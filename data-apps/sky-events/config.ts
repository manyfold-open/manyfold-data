import { defineDataApp } from '../../src/shared/data-app.ts';

export default defineDataApp({
  slug: 'sky-events',
  title: 'Sky Events',
  description: 'Eclipses, meteor showers, bright comets, planet gatherings and rocket launches you can watch: when they happen and where they can be seen.',
  license: 'CC-BY-4.0',
  noun: { one: 'event', other: 'events' },
  // One record per event: a launch that slips keeps its record, with the date corrected.
  identity: ['name', 'date'],
  fields: {
    name: {
      type: 'text',
      label: 'Event',
      required: true,
      max: 140,
      help: 'Its usual English name with the year or mission, e.g. "Total solar eclipse of 12 August 2026", "Perseids 2027" or "Artemis III launch".',
    },
    kind: {
      type: 'enum',
      label: 'Kind',
      required: true,
      values: ['solar-eclipse', 'lunar-eclipse', 'meteor-shower', 'comet', 'planets', 'rocket-launch'],
      valueLabels: {
        'solar-eclipse': 'Solar eclipse',
        'lunar-eclipse': 'Lunar eclipse',
        'meteor-shower': 'Meteor shower',
        comet: 'Comet',
        planets: 'Planets',
        'rocket-launch': 'Rocket launch',
      },
    },
    date: {
      type: 'date',
      label: 'Date',
      required: true,
      help: 'In UTC: the day of the eclipse, the shower’s peak, the comet’s best date as the page gives it, the planets’ closest approach or opposition, or the launch.',
    },
    time_utc: {
      type: 'text',
      label: 'Time (UTC)',
      max: 60,
      help: 'The time or window as the page states it, e.g. 17:46 UTC for an eclipse’s greatest point or a launch window.',
    },
    visible_in: {
      type: 'tags',
      names: true,
      label: 'Visible from',
      required: true,
      max: 12,
      help: 'Where it can be seen, in English, as the page names them, e.g. ["Spain", "Iceland", "Greenland"] or ["Northern Hemisphere"]; for a launch, where it can be watched, e.g. ["Florida"].',
    },
    rate_per_hour: {
      type: 'number',
      label: 'Meteors per hour',
      min: 0,
      help: 'For a meteor shower: the peak rate the page states (its zenithal hourly rate).',
    },
    agency: {
      type: 'text',
      label: 'Agency or company',
      max: 120,
      help: 'For a launch: who flies it, e.g. NASA and SpaceX, CNSA or ISRO.',
    },
    location: {
      type: 'text',
      label: 'Launch site',
      max: 140,
      help: 'For a launch: the site, e.g. Kennedy Space Center, Florida, or Wenchang, Hainan.',
    },
    url: {
      type: 'url',
      label: 'Official page',
      required: true,
      help: 'An official page: a space agency, an observatory or planetarium, the International Meteor Organization, or the launch provider.',
    },
  },
  accept: { date: { from: 'today', to: 'today+400' } },
  example: {
    data: {
      name: 'Total solar eclipse of 2 August 2027',
      kind: 'solar-eclipse',
      date: '2027-08-02',
      time_utc: '10:07 UTC',
      visible_in: ['Spain', 'Morocco', 'Egypt', 'Saudi Arabia'],
      url: 'https://example.org/eclipses/2027-08-02',
    },
    source_url: 'https://example.org/eclipses/2027-08-02',
    evidence:
      'The total solar eclipse of August 2, 2027 reaches its greatest point at 10:07 UTC, and totality will be visible from southern Spain, Morocco, Egypt and Saudi Arabia.',
  },
  table: {
    columns: ['name', 'kind', 'date', 'time_utc', 'visible_in', 'agency'],
    defaultSort: 'date',
    defaultFilter: { date: { from: 'today' } },
    previewTitle: 'Coming up',
    previewColumns: ['name', 'kind', 'date', 'visible_in'],
  },
  charts: [
    { kind: 'count', title: 'Coming up', where: { date: { from: 'today' } } },
    { kind: 'over-time', title: 'Events by month', field: 'date', bucket: 'month' },
    { kind: 'by-category', title: 'By kind', field: 'kind' },
    { kind: 'by-category', title: 'Where to watch', field: 'visible_in' },
  ],
  scope: {
    in: 'Solar and lunar eclipses, the peaks of major annual meteor showers, comets expected to be visible to the naked eye or with binoculars, naked-eye gatherings of planets and planetary oppositions, and crewed or landmark rocket launches — new rockets, Moon and planetary missions — with a public date, from today to about 13 months ahead.',
    out: 'Routine satellite launches, such as Starlink batches; minor meteor showers; events visible only through a telescope; astrology; past events.',
  },
  sourceHints: [
    'Space agencies’ pages, such as NASA, ESA, CNSA, JAXA and ISRO',
    'National observatories and planetariums, and timeanddate.com for eclipse paths and times',
    'The International Meteor Organization’s meteor shower calendar',
    'Launch providers’ mission pages, such as SpaceX, Blue Origin and Rocket Lab',
  ],
  recheckAfterDays: 14,
  notify: { line: '{name} · {kind} · {date} · {visible_in}' },
});
