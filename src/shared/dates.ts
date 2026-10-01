/** Calendar arithmetic on YYYY-MM-DD strings, in UTC. Runs in the browser and the Worker. */

const parse = (date: string) => new Date(`${date}T00:00:00Z`);
const print = (day: Date) => day.toISOString().slice(0, 10);

/** Monday of the week a date falls in (weeks start on Monday). */
export function weekStart(date: string): string {
  const day = parse(date);
  day.setUTCDate(day.getUTCDate() - ((day.getUTCDay() + 6) % 7));
  return print(day);
}

/** The first day of a date's month. */
export const monthStart = (date: string): string => `${date.slice(0, 7)}-01`;

/** The start of the next week or month after a bucket start. */
export function nextBucket(start: string, bucket: 'week' | 'month'): string {
  const day = parse(start);
  if (bucket === 'week') day.setUTCDate(day.getUTCDate() + 7);
  else day.setUTCMonth(day.getUTCMonth() + 1);
  return print(day);
}
