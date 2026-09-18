// DB access for request logs + dashboard stats.
// The list query deliberately omits requestBody/responseBody (potentially
// large); the detail query returns the full row.

import { desc, eq, sql, type SQL } from "drizzle-orm";
import { db } from "./index";
import { accounts, requestLogs } from "./schema";

export interface FilterApplicationRow {
  id: number;
  pattern: string;
  hits: number;
}

export interface RequestLogInsert {
  provider: string;
  model?: string | null;
  accountId?: number | null;
  accountLabel?: string | null;
  stream?: boolean;
  source?: string;
  status: "success" | "error";
  httpStatus?: number | null;
  outcome?: string | null;
  durationMs?: number | null;
  promptTokens?: number | null;
  completionTokens?: number | null;
  cachedTokens?: number | null;
  cacheWriteTokens?: number | null;
  reasoningTokens?: number | null;
  ttftMs?: number | null;
  creditUsed?: number | null;
  dollarCost?: number | null;
  errorMessage?: string | null;
  requestBody?: string | null;
  responseBody?: string | null;
  filtersApplied?: FilterApplicationRow[] | null;
}

// The row shape the list endpoint returns — everything except the bodies.
export interface RequestLogRow {
  id: number;
  createdAt: Date;
  provider: string;
  model: string | null;
  accountId: number | null;
  accountLabel: string | null;
  stream: boolean;
  source: string;
  status: string;
  httpStatus: number | null;
  outcome: string | null;
  durationMs: number | null;
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  cachedTokens: number | null;
  cacheWriteTokens: number | null;
  reasoningTokens: number | null;
  ttftMs: number | null;
  creditUsed: number | null;
  dollarCost: number | null;
  errorMessage: string | null;
  filtersApplied: FilterApplicationRow[] | null;
}

const LIST_COLUMNS = {
  id: requestLogs.id,
  createdAt: requestLogs.createdAt,
  provider: requestLogs.provider,
  model: requestLogs.model,
  accountId: requestLogs.accountId,
  accountLabel: requestLogs.accountLabel,
  stream: requestLogs.stream,
  source: requestLogs.source,
  status: requestLogs.status,
  httpStatus: requestLogs.httpStatus,
  outcome: requestLogs.outcome,
  durationMs: requestLogs.durationMs,
  promptTokens: requestLogs.promptTokens,
  completionTokens: requestLogs.completionTokens,
  totalTokens: requestLogs.totalTokens,
  cachedTokens: requestLogs.cachedTokens,
  cacheWriteTokens: requestLogs.cacheWriteTokens,
  reasoningTokens: requestLogs.reasoningTokens,
  ttftMs: requestLogs.ttftMs,
  creditUsed: requestLogs.creditUsed,
  dollarCost: requestLogs.dollarCost,
  errorMessage: requestLogs.errorMessage,
  filtersApplied: requestLogs.filtersApplied,
} as const;

export function insertRequestLog(row: RequestLogInsert): number {
  const total =
    row.promptTokens != null || row.completionTokens != null
      ? (row.promptTokens ?? 0) + (row.completionTokens ?? 0)
      : null;
  return db
    .insert(requestLogs)
    .values({ ...row, totalTokens: total })
    .returning({ id: requestLogs.id })
    .get().id;
}

export function listRequestLogs(opts: {
  limit?: number;
  offset?: number;
  provider?: string;
}): RequestLogRow[] {
  const filters: SQL[] = [];
  if (opts.provider) filters.push(eq(requestLogs.provider, opts.provider));
  return db
    .select(LIST_COLUMNS)
    .from(requestLogs)
    .where(filters.length ? sql.join(filters, sql` and `) : undefined)
    .orderBy(desc(requestLogs.id))
    .limit(opts.limit ?? 100)
    .offset(opts.offset ?? 0)
    .all();
}

export function getRequestLog(id: number) {
  return db.select().from(requestLogs).where(eq(requestLogs.id, id)).get();
}

// Same shape as listRequestLogs but for a single id — used by the WS event
// emitter so subscribers get a ready-to-render RequestLogRow without a
// second fetch. Reading through the same LIST_COLUMNS projection guarantees
// emit payload never drifts from what the /stats/requests list returns.
export function getRequestLogRow(id: number): RequestLogRow | undefined {
  return db.select(LIST_COLUMNS).from(requestLogs).where(eq(requestLogs.id, id)).get();
}

// Patch an existing row. Used by the video poller to fill in final cost +
// duration after the async render finishes — the submit-time row starts with
// only the HTTP round-trip timing and no usage numbers.
export function updateRequestLog(
  id: number,
  patch: Partial<
    Pick<
      RequestLogInsert,
      | "status"
      | "outcome"
      | "durationMs"
      | "promptTokens"
      | "completionTokens"
      | "cachedTokens"
      | "cacheWriteTokens"
      | "reasoningTokens"
      | "creditUsed"
      | "dollarCost"
      | "errorMessage"
      | "responseBody"
    >
  >
): boolean {
  const set: Record<string, unknown> = {};
  if (patch.status !== undefined) set.status = patch.status;
  if (patch.outcome !== undefined) set.outcome = patch.outcome;
  if (patch.durationMs !== undefined) set.durationMs = patch.durationMs;
  if (patch.promptTokens !== undefined) set.promptTokens = patch.promptTokens;
  if (patch.completionTokens !== undefined) set.completionTokens = patch.completionTokens;
  if (patch.cachedTokens !== undefined) set.cachedTokens = patch.cachedTokens;
  if (patch.cacheWriteTokens !== undefined) set.cacheWriteTokens = patch.cacheWriteTokens;
  if (patch.reasoningTokens !== undefined) set.reasoningTokens = patch.reasoningTokens;
  if (patch.creditUsed !== undefined) set.creditUsed = patch.creditUsed;
  if (patch.dollarCost !== undefined) set.dollarCost = patch.dollarCost;
  if (patch.errorMessage !== undefined) set.errorMessage = patch.errorMessage;
  if (patch.responseBody !== undefined) set.responseBody = patch.responseBody;
  // Recompute total_tokens if either token field was touched so the derived
  // column stays consistent with the source ones.
  if (patch.promptTokens !== undefined || patch.completionTokens !== undefined) {
    const cur = db
      .select({ p: requestLogs.promptTokens, c: requestLogs.completionTokens })
      .from(requestLogs)
      .where(eq(requestLogs.id, id))
      .get();
    const p = patch.promptTokens ?? cur?.p ?? 0;
    const c = patch.completionTokens ?? cur?.c ?? 0;
    set.totalTokens = p + c;
  }
  if (Object.keys(set).length === 0) return false;
  const r = db
    .update(requestLogs)
    .set(set)
    .where(eq(requestLogs.id, id))
    .returning({ id: requestLogs.id })
    .get();
  return r !== undefined;
}

// ── Dashboard stats ──────────────────────────────────────────────

export interface DashboardStats {
  pool: { total: number; active: number; exhausted: number; banned: number };
  requests: { total: number; success: number };
  tokens: { total: number; prompt: number; completion: number };
}

export function dashboardStats(): DashboardStats {
  const poolRow = db
    .select({
      total: sql<number>`count(*)`,
      active: sql<number>`coalesce(sum(case when ${accounts.status} = 'active' then 1 else 0 end), 0)`,
      exhausted: sql<number>`coalesce(sum(case when ${accounts.status} = 'exhausted' then 1 else 0 end), 0)`,
      banned: sql<number>`coalesce(sum(case when ${accounts.status} = 'banned' then 1 else 0 end), 0)`,
    })
    .from(accounts)
    .get();

  const reqRow = db
    .select({
      total: sql<number>`count(*)`,
      success: sql<number>`coalesce(sum(case when ${requestLogs.status} = 'success' then 1 else 0 end), 0)`,
      prompt: sql<number>`coalesce(sum(${requestLogs.promptTokens}), 0)`,
      completion: sql<number>`coalesce(sum(${requestLogs.completionTokens}), 0)`,
    })
    .from(requestLogs)
    .get();

  return {
    pool: {
      total: poolRow?.total ?? 0,
      active: poolRow?.active ?? 0,
      exhausted: poolRow?.exhausted ?? 0,
      banned: poolRow?.banned ?? 0,
    },
    requests: { total: reqRow?.total ?? 0, success: reqRow?.success ?? 0 },
    tokens: {
      total: (reqRow?.prompt ?? 0) + (reqRow?.completion ?? 0),
      prompt: reqRow?.prompt ?? 0,
      completion: reqRow?.completion ?? 0,
    },
  };
}

export interface ModelUsageRow {
  provider: string;
  model: string | null;
  requests: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export function modelUsage(): ModelUsageRow[] {
  return db
    .select({
      provider: requestLogs.provider,
      model: requestLogs.model,
      requests: sql<number>`count(*)`,
      promptTokens: sql<number>`coalesce(sum(${requestLogs.promptTokens}), 0)`,
      completionTokens: sql<number>`coalesce(sum(${requestLogs.completionTokens}), 0)`,
      totalTokens: sql<number>`coalesce(sum(${requestLogs.totalTokens}), 0)`,
    })
    .from(requestLogs)
    .groupBy(requestLogs.provider, requestLogs.model)
    .orderBy(sql`sum(${requestLogs.totalTokens}) desc`)
    .all();
}

// ── Time-ranged usage (dashboard Token Usage card) ───────────────

export type UsageRange = "1d" | "7d" | "30d" | "all";

export interface UsageBucket {
  // Bucket start, unix ms. 1d → hourly buckets, 7d/30d → daily, all → monthly.
  t: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  requests: number;
}

export interface UsageReport {
  range: UsageRange;
  prompt: number;
  completion: number;
  total: number;
  requests: number;
  buckets: UsageBucket[];
  models: ModelUsageRow[];
}

function rangeStart(range: UsageRange): number | null {
  // created_at is stored as unix SECONDS (drizzle timestamp mode), so range
  // math happens in seconds too.
  const nowSec = Math.floor(Date.now() / 1000);
  if (range === "1d") return nowSec - 24 * 3600;
  if (range === "7d") return nowSec - 7 * 24 * 3600;
  if (range === "30d") return nowSec - 30 * 24 * 3600;
  return null; // all
}

// Bucket width in ms + sqlite strftime pattern for the grouping.
const BUCKET: Record<UsageRange, { ms: number; fmt: string }> = {
  "1d": { ms: 3600_000, fmt: "%Y-%m-%d %H:00" },
  "7d": { ms: 86_400_000, fmt: "%Y-%m-%d" },
  "30d": { ms: 86_400_000, fmt: "%Y-%m-%d" },
  all: { ms: 30 * 86_400_000, fmt: "%Y-%m" },
};

export function usageReport(range: UsageRange): UsageReport {
  const start = rangeStart(range);
  const bucket = BUCKET[range];

  // created_at is unix seconds — strftime consumes it directly.
  const bucketExpr = sql`strftime(${bucket.fmt}, ${requestLogs.createdAt}, 'unixepoch')`;
  const where = start != null ? sql`where ${requestLogs.createdAt} >= ${start}` : sql``;

  const rows = db.all<{
    bucket: string;
    prompt: number;
    completion: number;
    total: number;
    requests: number;
    t: number;
  }>(sql`
    select ${bucketExpr} as bucket,
      coalesce(sum(${requestLogs.promptTokens}), 0) as prompt,
      coalesce(sum(${requestLogs.completionTokens}), 0) as completion,
      coalesce(sum(${requestLogs.totalTokens}), 0) as total,
      count(*) as requests,
      min(${requestLogs.createdAt}) as t
    from ${requestLogs}
    ${where}
    group by ${bucketExpr}
    order by t asc
  `);

  const totals = db.all<{
    prompt: number;
    completion: number;
    total: number;
    requests: number;
  }>(sql`
    select
      coalesce(sum(${requestLogs.promptTokens}), 0) as prompt,
      coalesce(sum(${requestLogs.completionTokens}), 0) as completion,
      coalesce(sum(${requestLogs.totalTokens}), 0) as total,
      count(*) as requests
    from ${requestLogs}
    ${where}
  `)[0] ?? { prompt: 0, completion: 0, total: 0, requests: 0 };

  const models = db.all<ModelUsageRow>(sql`
    select ${requestLogs.provider} as provider,
      ${requestLogs.model} as model,
      count(*) as requests,
      coalesce(sum(${requestLogs.promptTokens}), 0) as promptTokens,
      coalesce(sum(${requestLogs.completionTokens}), 0) as completionTokens,
      coalesce(sum(${requestLogs.totalTokens}), 0) as totalTokens
    from ${requestLogs}
    ${where}
    group by ${requestLogs.provider}, ${requestLogs.model}
    order by sum(${requestLogs.totalTokens}) desc
  `);

  return {
    range,
    prompt: totals.prompt,
    completion: totals.completion,
    total: totals.total,
    requests: totals.requests,
    buckets: rows.map((r) => ({
      t: r.t * 1000, // stored seconds → ms for the UI
      promptTokens: r.prompt,
      completionTokens: r.completion,
      totalTokens: r.total,
      requests: r.requests,
    })),
    models,
  };
}
