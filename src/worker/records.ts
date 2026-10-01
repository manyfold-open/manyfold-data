/**
 * Reading records for the public: Table parameters (src/shared/query.ts) turned into
 * SQL over verified rows, facet counts for the filters, and one record with its history.
 */

import { resolveDateBound, type DataAppConfig } from '../shared/data-app';
import type { QueryState } from '../shared/query';
import type {
  AppSummary,
  FacetCount,
  MergedResponse,
  PublicRecord,
  PublicStatus,
  RecordResponse,
  RecordsResponse,
} from '../shared/types';
import { fieldSql } from './db';

export interface SqlWhere {
  sql: string;
  params: (string | number)[];
}

const escapeLike = (text: string): string => text.replace(/[\\%_]/g, (char) => `\\${char}`);

/**
 * WHERE clause over one data app's verified records. Field names reach the SQL text
 * only after parseQuery() matched them against the config; every value is a bound
 * parameter. `skip` leaves out one field's filter, for that field's own facet counts.
 */
export function buildWhere(
  config: DataAppConfig,
  state: QueryState,
  today: string,
  skip?: string,
): SqlWhere {
  const clauses = ['app_slug = ?', "status = 'verified'"];
  const params: (string | number)[] = [config.slug];

  if (state.q) {
    // Text fields, and lists of names (cities): their JSON text holds every name.
    const textFields = Object.keys(config.fields).filter((field) => {
      const def = config.fields[field];
      return def?.type === 'text' || (def?.type === 'tags' && def.names === true);
    });
    if (textFields.length > 0) {
      clauses.push(`(${textFields.map((field) => `${fieldSql(field)} LIKE ? ESCAPE '\\'`).join(' OR ')})`);
      const pattern = `%${escapeLike(state.q)}%`;
      textFields.forEach(() => params.push(pattern));
    }
  }

  for (const [field, filter] of Object.entries(state.filters)) {
    const def = config.fields[field];
    if (!def || field === skip) continue;
    if (filter.kind === 'in') {
      if (filter.values.length === 0) continue;
      const marks = filter.values.map(() => '?').join(', ');
      clauses.push(
        def.type === 'tags'
          ? `EXISTS (SELECT 1 FROM json_each(records.data_json, '$.${field}') WHERE json_each.value IN (${marks}))`
          : `${fieldSql(field)} IN (${marks})`,
      );
      params.push(...filter.values);
    } else {
      for (const [end, operator] of [
        ['from', '>='],
        ['to', '<='],
      ] as const) {
        const raw = filter[end];
        if (raw === undefined) continue;
        clauses.push(`${fieldSql(field)} ${operator} ?`);
        params.push(def.type === 'number' ? Number(raw) : resolveDateBound(raw, today));
      }
    }
  }
  return { sql: clauses.join(' AND '), params };
}

/** ORDER BY for a query: missing values last in both directions, text without case. */
export function orderBy(config: DataAppConfig, state: QueryState): string {
  const column = fieldSql(state.sort.field);
  const collate = config.fields[state.sort.field]?.type === 'text' ? ' COLLATE NOCASE' : '';
  return `${column} IS NULL, ${column}${collate} ${state.sort.desc ? 'DESC' : 'ASC'}, id`;
}

function facetStatement(
  db: D1Database,
  config: DataAppConfig,
  state: QueryState,
  field: string,
  today: string,
): D1PreparedStatement {
  const where = buildWhere(config, state, today, field);
  if (config.fields[field]?.type === 'tags') {
    return db
      .prepare(
        `SELECT json_each.value AS value, COUNT(*) AS n
         FROM records, json_each(records.data_json, '$.${field}')
         WHERE ${where.sql}
         GROUP BY json_each.value ORDER BY n DESC, value LIMIT 200`,
      )
      .bind(...where.params);
  }
  return db
    .prepare(
      `SELECT ${fieldSql(field)} AS value, COUNT(*) AS n FROM records
       WHERE ${where.sql} AND ${fieldSql(field)} IS NOT NULL
       GROUP BY value ORDER BY n DESC, value`,
    )
    .bind(...where.params);
}

interface RecordRow {
  id: string;
  status: string;
  data_json: string;
  source_url: string;
  observed_at: string;
  verified_at: string | null;
  updated_at: string;
}

const LIST_COLUMNS = 'id, status, data_json, source_url, observed_at, verified_at, updated_at';

const toPublic = (row: RecordRow): PublicRecord => ({
  id: row.id,
  status: row.status as PublicStatus,
  data: JSON.parse(row.data_json),
  source_url: row.source_url,
  observed_at: row.observed_at,
  verified_at: row.verified_at,
  updated_at: row.updated_at,
});

const toFacets = (rows: { value: string; n: number }[]): FacetCount[] =>
  rows.map((row) => ({ value: String(row.value), count: row.n }));

/** One page of verified records, the total, and facet counts — in one D1 round trip. */
export async function listRecords(
  db: D1Database,
  config: DataAppConfig,
  state: QueryState,
  limit: number,
  today: string,
  options: { facets?: boolean } = {},
): Promise<RecordsResponse> {
  const where = buildWhere(config, state, today);
  // Each facet scans the data app's records once more; callers that only show rows skip them.
  const facetFields =
    options.facets === false
      ? []
      : Object.keys(config.fields).filter((field) => {
          const type = config.fields[field]?.type;
          return type === 'enum' || type === 'tags';
        });

  const [count, page, ...facets] = await db.batch<unknown>([
    db.prepare(`SELECT COUNT(*) AS n FROM records WHERE ${where.sql}`).bind(...where.params),
    db
      .prepare(
        `SELECT ${LIST_COLUMNS} FROM records WHERE ${where.sql}
         ORDER BY ${orderBy(config, state)} LIMIT ? OFFSET ?`,
      )
      .bind(...where.params, limit, (state.page - 1) * limit),
    ...facetFields.map((field) => facetStatement(db, config, state, field, today)),
  ]);

  return {
    total: (count?.results[0] as { n: number } | undefined)?.n ?? 0,
    page: state.page,
    limit,
    today,
    records: ((page?.results ?? []) as RecordRow[]).map(toPublic),
    facets: Object.fromEntries(
      facetFields.map((field, index) => [
        field,
        toFacets((facets[index]?.results ?? []) as { value: string; n: number }[]),
      ]),
    ),
  };
}

/** Who a revision's actor is, in words a reader understands. */
const actorLabel = (actor: string, tokenLabel: string | null): string =>
  actor === 'seed' ? 'Manyfold team (seed data)' : actor === 'admin' ? 'Admin' : (tokenLabel ?? 'An agent');

/**
 * One record with its history. Null when it does not exist or is not public; a pointer
 * when it was merged into another record. `unsure` notes are working notes for the
 * admin, so the public history leaves them out.
 */
export async function getRecord(
  db: D1Database,
  config: DataAppConfig,
  id: string,
): Promise<RecordResponse | MergedResponse | null> {
  const row = await db
    .prepare(
      `SELECT ${LIST_COLUMNS}, evidence, created_at, merged_into FROM records
       WHERE app_slug = ? AND id = ?`,
    )
    .bind(config.slug, id)
    .first<RecordRow & { evidence: string; created_at: string; merged_into: string | null }>();
  if (!row) return null;
  if (row.status === 'merged' && row.merged_into) return { merged_into: row.merged_into };
  if (row.status !== 'verified' && row.status !== 'stale') return null;

  const revisions = await db
    .prepare(
      `SELECT r.action, r.actor, r.reason, r.created_at, t.label
       FROM revisions r LEFT JOIN tokens t ON t.id = r.actor
       WHERE r.record_id = ? AND r.action != 'unsure' ORDER BY r.id`,
    )
    .bind(id)
    .all<{ action: string; actor: string; reason: string | null; created_at: string; label: string | null }>();

  return {
    record: { ...toPublic(row), evidence: row.evidence, created_at: row.created_at },
    revisions: revisions.results.map((revision) => ({
      action: revision.action,
      actor: actorLabel(revision.actor, revision.label),
      reason: revision.reason,
      created_at: revision.created_at,
    })),
  };
}

/** Every data app with its count of verified records and the time its data last changed. */
export async function appSummaries(
  db: D1Database,
  apps: readonly DataAppConfig[],
): Promise<AppSummary[]> {
  const { results } = await db
    .prepare(
      `SELECT app_slug, COUNT(*) AS n, MAX(updated_at) AS last FROM records
       WHERE status = 'verified' GROUP BY app_slug`,
    )
    .all<{ app_slug: string; n: number; last: string | null }>();
  return apps.map((app) => {
    const row = results.find((result) => result.app_slug === app.slug);
    return {
      slug: app.slug,
      title: app.title,
      description: app.description,
      license: app.license,
      verified: row?.n ?? 0,
      lastUpdated: row?.last ?? null,
    };
  });
}
