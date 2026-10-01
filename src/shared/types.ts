/**
 * Shapes of the public read API, shared by the Worker that sends them and the pages
 * that read them.
 */

import type { FieldError, RecordData } from './data-app.ts';

export interface ApiErrorBody {
  error: { code: string; message: string };
}

/* ───────── agents ───────── */

export interface JoinResponse {
  /** Shown once. Only its hash is stored. */
  token: string;
  token_id: string;
  role: 'collector';
  pending_cap: number;
  skill_url: string;
  note: string;
}

/** A token's records on one data app, its cap, and anything it should change. */
export interface Standing {
  pending: number;
  verified: number;
  rejected: number;
  merged: number;
  stale: number;
  /** Most records the token may have waiting for review at once. */
  pending_cap: number;
  warnings: string[];
}

/** A maintainer token's workload on one data app today (UTC). */
export interface Work {
  /** Tasks leased to the token right now. */
  leased: number;
  /** Verdicts the token sent today. */
  done_today: number;
  daily_task_limit: number;
}

export interface MeResponse {
  token_id: string;
  role: 'collector' | 'maintainer';
  label: string;
  status: 'active' | 'suspended' | 'revoked';
  apps: string[];
  created_at: string;
  /** One entry per data app the token works on. */
  standing: Record<string, Standing>;
  /** Maintainer tokens only: workload per data app. */
  work?: Record<string, Work>;
}

export type TaskKind = 'verify' | 'recheck';
export type Verdict = 'verified' | 'rejected' | 'duplicate' | 'stale' | 'unsure';

export interface LeasedTask {
  id: string;
  kind: TaskKind;
  lease_expires_at: string;
  record: {
    id: string;
    status: 'pending' | 'verified';
    data: RecordData;
    source_url: string;
    evidence: string;
    observed_at: string;
    submitted_at: string;
    verified_at: string | null;
  };
}

export interface LeaseResponse extends Work {
  /** Every task leased to this token now, the ones just leased included. */
  tasks: LeasedTask[];
}

export type VerdictResult =
  | { index: number; task_id: string; status: 'applied'; record_status: string }
  | { index: number; task_id: string | null; status: 'error'; errors: FieldError[] };

export interface VerdictsResponse extends Work {
  results: VerdictResult[];
}

/** A token as the admin sees it. Never carries the secret. */
export interface AdminToken {
  id: string;
  role: 'collector' | 'maintainer';
  label: string;
  apps: string[];
  status: 'active' | 'suspended' | 'revoked';
  pending_cap: number | null;
  daily_task_limit: number | null;
  expires_at: string | null;
  last_used_at: string | null;
  created_at: string;
  records: { pending: number; verified: number; rejected: number };
  verdicts: { total: number; today: number };
}

/** The one answer that carries a maintainer token's secret. */
export interface IssuedToken extends AdminToken {
  token: string;
  note: string;
}

export type SubmitResult =
  | { index: number; status: 'accepted'; id: string }
  | { index: number; status: 'duplicate'; existing_id: string }
  | { index: number; status: 'invalid'; errors: FieldError[] }
  | { index: number; status: 'source_not_found'; message: string }
  | { index: number; status: 'over_cap'; message: string };

export interface SubmitResponse {
  /** One result per submitted record, in the order sent. */
  results: SubmitResult[];
  pending: number;
  pending_cap: number;
  warnings: string[];
}

/* ───────── public read API ───────── */

export interface AppSummary {
  slug: string;
  title: string;
  description: string;
  license: string;
  verified: number;
  lastUpdated: string | null;
}

export interface AppsResponse {
  apps: AppSummary[];
}

/** Statuses a public reader can see. Pending, rejected and merged records stay private. */
export type PublicStatus = 'verified' | 'stale';

export interface PublicRecord {
  id: string;
  status: PublicStatus;
  data: RecordData;
  source_url: string;
  observed_at: string;
  verified_at: string | null;
  updated_at: string;
}

export interface FacetCount {
  value: string;
  count: number;
}

export interface RecordsResponse {
  total: number;
  page: number;
  limit: number;
  /** The UTC date the Worker read 'today' as. */
  today: string;
  records: PublicRecord[];
  /** Counts per value of each enum and tags field, under every other active filter. */
  facets: Record<string, FacetCount[]>;
}

export interface PublicRevision {
  action: string;
  actor: string;
  reason: string | null;
  created_at: string;
}

export interface RecordResponse {
  record: PublicRecord & { evidence: string; created_at: string };
  revisions: PublicRevision[];
}

/** Answer for a record that was merged into another: go there instead. */
export interface MergedResponse {
  merged_into: string;
}

export type ChartResult =
  | { kind: 'count'; title: string; value: number }
  | {
      kind: 'over-time';
      title: string;
      field: string;
      bucket: 'week' | 'month';
      points: { start: string; count: number }[];
    }
  | { kind: 'by-category'; title: string; field: string; bars: FacetCount[] }
  | {
      kind: 'histogram';
      title: string;
      field: string;
      bins: { from: number; to: number | null; count: number }[];
      /** Records without a value for the field. */
      missing: number;
    };

export interface StatsResponse {
  today: string;
  tiles: {
    verified: number;
    addedLast7Days: number;
    pending: number;
    lastUpdated: string | null;
  };
  /** One result per chart in the config, in the same order. */
  charts: ChartResult[];
}

/* ───────── admin console ───────── */

export type RecordStatus = 'pending' | 'verified' | 'rejected' | 'merged' | 'stale';

export interface Actor {
  id: string;
  label: string;
}

export interface NotifyStatus {
  slug: string;
  title: string;
  configured: boolean;
  /** The webhook with its secret part hidden. */
  masked: string | null;
  state: 'active' | 'paused' | 'failing' | 'off';
  failures: number;
  last_sent_at: string | null;
  last_error: string | null;
  /** Verified records waiting to be announced. */
  waiting: number;
}

export interface AppOverview {
  slug: string;
  title: string;
  counts: Record<RecordStatus, number>;
  /** Tasks waiting for a maintainer or held by one. */
  open_tasks: number;
  /** Items in the review queue: unsure verdicts, flagged records, open reports. */
  review: number;
  notify: NotifyStatus;
}

export interface AdminRecord {
  id: string;
  app_slug: string;
  status: RecordStatus;
  name: string;
  data: RecordData;
  source_url: string;
  evidence: string;
  observed_at: string;
  submitted_by: Actor;
  flagged: boolean;
  merged_into: string | null;
  created_at: string;
  updated_at: string;
  verified_at: string | null;
}

export interface AdminRevision {
  id: number;
  action: string;
  actor: Actor;
  reason: string | null;
  before: unknown;
  after: unknown;
  source_url: string | null;
  evidence: string | null;
  created_at: string;
}

export interface Report {
  id: number;
  record_id: string;
  reason: string;
  status: 'open' | 'resolved';
  created_at: string;
}

export interface AdminRecordDetail {
  record: AdminRecord;
  revisions: AdminRevision[];
  tasks: { id: string; kind: TaskKind; status: string; leased_to: string | null; created_at: string }[];
  reports: Report[];
}

export interface ReviewItem {
  kind: 'unsure' | 'flagged' | 'report';
  record: AdminRecord;
  reason: string;
  by: string | null;
  at: string;
  task_id: string | null;
  report_id: number | null;
}

export interface ActivityItem {
  id: number;
  app_slug: string;
  record_id: string;
  record_name: string;
  action: string;
  actor: Actor;
  reason: string | null;
  created_at: string;
}

export interface RevertReport {
  reverted: number;
  skipped: { record_id: string; reason: string }[];
}

export interface SpotCheck {
  /** ISO week, e.g. 2026-W40. The sample stays the same all week. */
  week: string;
  items: { record: AdminRecord; mark: { correct: boolean; note: string | null; checked_at: string } | null }[];
  marked: number;
  correct: number;
}
