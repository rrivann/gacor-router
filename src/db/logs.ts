// DB access for request logs + dashboard stats.
// The list query deliberately omits requestBody/responseBody (potentially
// large); the detail query returns the full row.

import { desc, eq, sql, type SQL } from "drizzle-orm";
import { db } from "./index";
import { accounts, requestLogs } from "./schema";

export interface RequestLogInsert {
  provider: string;
  model?: string | null;
  accountId?: number | null;
  accountLabel?: string | null;
  stream?: boolean;
  status: "success" | "error";
  httpStatus?: number | null;
  outcome?: string | null;
  durationMs?: number | null;
  promptTokens?: number | null;
  completionTokens?: number | null;
  creditUsed?: number | null;
  errorMessage?: string | null;
  requestBody?: string | null;
  responseBody?: string | null;
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
  status: string;
  httpStatus: number | null;
  outcome: string | null;
  durationMs: number | null;
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  creditUsed: number | null;
  errorMessage: string | null;
}

const LIST_COLUMNS = {
  id: requestLogs.id,
  createdAt: requestLogs.createdAt,
  provider: requestLogs.provider,
  model: requestLogs.model,
  accountId: requestLogs.accountId,
  accountLabel: requestLogs.accountLabel,
  stream: requestLogs.stream,
  status: requestLogs.status,
  httpStatus: requestLogs.httpStatus,
  outcome: requestLogs.outcome,
  durationMs: requestLogs.durationMs,
  promptTokens: requestLogs.promptTokens,
  completionTokens: requestLogs.completionTokens,
  totalTokens: requestLogs.totalTokens,
  creditUsed: requestLogs.creditUsed,
  errorMessage: requestLogs.errorMessage,
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
