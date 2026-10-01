/**
 * The last Table view per data app, so Back and the {noun} tab return to the filters the
 * reader left, not the default view. Kept in memory for this tab only.
 */

const lastTable = new Map<string, string>();

export const rememberTable = (slug: string, search: string): void => {
  lastTable.set(slug, `/${slug}/table${search}`);
};

export const tableHrefFor = (slug: string): string => lastTable.get(slug) ?? `/${slug}/table`;
