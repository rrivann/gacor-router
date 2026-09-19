// Drizzle schema. Started minimal; grows as features land.
// Conventions:
// - snake_case column names, camelCase TS fields
// - timestamps as integer unix ms via mode: "timestamp"

import { sqliteTable, text, integer, real, index, uniqueIndex } from "drizzle-orm/sqlite-core";

// Upstream accounts (one row per credential). `secret` is the single-token
// case; `creds` (JSON) carries multi-field sets like {access_token, refresh_token, region}.
// Status lifecycle mirrors enowX Outcome enum: active | exhausted | banned.
export const accounts = sqliteTable(
  "accounts",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    provider: text("provider").notNull(),
    label: text("label"),
    secret: text("secret").notNull().default(""),
    creds: text("creds", { mode: "json" }).$type<Record<string, string>>(),
    status: text("status", { mode: "text" }).notNull().default("active"),
    // Last fetched credit/quota snapshot (from the provider's billing API),
    // cached so the dashboard doesn't hammer upstream on every render.
    usageJson: text("usage_json", { mode: "json" }).$type<Record<string, unknown>>(),
    usageAt: integer("usage_at", { mode: "timestamp" }),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [index("idx_accounts_provider_status").on(t.provider, t.status)]
);

// Simple KV settings (pool rotation mode per provider, etc).
export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

// AI Chat playground sessions. `messages` is the frontend's ChatMsg[] as an
// opaque JSON blob — the backend never inspects it, just stores and returns.
export const chatSessions = sqliteTable("chat_sessions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  title: text("title").notNull().default("New chat"),
  model: text("model").notNull().default(""),
  messages: text("messages").notNull().default("[]"),
  msgCount: integer("msg_count").notNull().default(0),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// Content filters: pattern→replacement rules applied to outbound message text
// before the request leaves. Used to swap words some upstreams block (brand
// names, tokens) so the traffic goes through cleanly. Deobfuscating the reply
// is a future extension.
export const contentFilters = sqliteTable(
  "content_filters",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    pattern: text("pattern").notNull(),
    replacement: text("replacement").notNull().default(""),
    isRegex: integer("is_regex", { mode: "boolean" }).notNull().default(false),
    isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
    sort: integer("sort").notNull().default(0),
    // null = global (apply to every provider). Non-empty JSON array restricts
    // the rule to those provider names. Empty array is normalized to null in
    // the API layer so the DB only holds one representation of "global".
    providerScope: text("provider_scope", { mode: "json" }).$type<string[] | null>(),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [index("idx_content_filters_sort").on(t.sort)]
);

// Client-facing API keys — the token a client (Code Assistant, Cursor, curl…) sends
// in `Authorization: Bearer …` to authenticate to /v1/*. Stored plaintext so
// the dashboard can reveal for copy; the file is local and single-user. Scope
// columns restrict which models/providers a key may address; null = allow all.
export const apiKeys = sqliteTable(
  "api_keys",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    label: text("label").notNull().default(""),
    secret: text("secret").notNull(),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    // Cumulative token cap; 0 = unlimited. Counted against total_tokens per
    // successful request.
    tokenLimit: integer("token_limit").notNull().default(0),
    tokensUsed: integer("tokens_used").notNull().default(0),
    // Max in-flight requests for this key; 0 = unlimited.
    maxConcurrent: integer("max_concurrent").notNull().default(0),
    // null = never expires. Compared against Date.now() at auth time.
    expiresAt: integer("expires_at", { mode: "timestamp" }),
    lastUsedAt: integer("last_used_at", { mode: "timestamp" }),
    // Model scope: null = all, non-empty array = only these model IDs (matched
    // against the resolved provider/model or the tail).
    allowedModels: text("allowed_models", { mode: "json" }).$type<string[] | null>(),
    // Provider scope: null = all, non-empty array = only these providers.
    allowedProviders: text("allowed_providers", { mode: "json" }).$type<string[] | null>(),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [uniqueIndex("idx_api_keys_secret").on(t.secret)]
);

// One row per completed (or failed) proxied request. The list endpoint omits
// requestBody/responseBody to stay light; a per-row detail endpoint returns
// them for the UI drawer. Token columns come from the upstream usage event
// when present.
export const requestLogs = sqliteTable(
  "request_logs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
    provider: text("provider").notNull(),
    model: text("model"),
    accountId: integer("account_id"),
    accountLabel: text("account_label"),
    stream: integer("stream", { mode: "boolean" }).notNull().default(false),
    // What generated this row: "proxy" (client traffic) or "warmup" (probe).
    source: text("source").notNull().default("proxy"),
    status: text("status", { mode: "text" }).notNull(), // success | error
    httpStatus: integer("http_status"),
    outcome: text("outcome"), // ok | transient | exhausted | dead (final)
    durationMs: integer("duration_ms"),
    promptTokens: integer("prompt_tokens"),
    completionTokens: integer("completion_tokens"),
    totalTokens: integer("total_tokens"),
    // Cached tokens hit on the upstream — sum of read + write. Kept as an
    // aggregate for the compact list view; the drawer splits via
    // cacheWriteTokens (cache_read = cachedTokens - cacheWriteTokens).
    cachedTokens: integer("cached_tokens"),
    // Cache creation portion (remove's cache_creation_input_tokens or Tencent's
    // prompt_cache_write_tokens). Null when upstream doesn't split, or a plain
    // cache read (no write happened this turn).
    cacheWriteTokens: integer("cache_write_tokens"),
    // Reasoning-model output split (a subset of completion_tokens). Null when
    // upstream doesn't split (non-reasoning models, models that inline it).
    reasoningTokens: integer("reasoning_tokens"),
    // True when reasoning_tokens is a client-side estimate from streamed
    // reasoning_content (upstream returned null but the model streamed thinking
    // deltas). Null on non-reasoning rows and on rows where upstream reported
    // a real count. Dashboard renders "~N (est)" instead of "N" when true.
    reasoningEstimated: integer("reasoning_estimated", { mode: "boolean" }),
    // Time-to-first-token: wall-clock ms from proxy pick → first non-empty
    // content delta. A responsiveness signal separate from total durationMs.
    ttftMs: integer("ttft_ms"),
    // Upstream-reported credit cost (CodeBuddy usage event), when metered.
    // Fractional — a request can cost e.g. 0.57 credits.
    creditUsed: real("credit_used"),
    // Retail-equivalent USD cost computed from src/lib/pricing.ts. Null when
    // the model isn't in the pricing table. Independent of upstream credit —
    // useful for comparing gateway savings vs direct API spend.
    dollarCost: real("dollar_cost"),
    errorMessage: text("error_message"),
    requestBody: text("request_body"),
    responseBody: text("response_body"),
    // Per-rule breakdown of content filters that fired on this request
    // (id + pattern + hit count). Null when the request had no filter
    // matches or predates v0.3.11. Rendered in /requests detail drawer.
    filtersApplied: text("filters_applied", { mode: "json" }).$type<
      { id: number; pattern: string; hits: number }[]
    >(),
  },
  (t) => [
    index("idx_request_logs_created").on(t.createdAt),
    index("idx_request_logs_provider_created").on(t.provider, t.createdAt),
  ]
);

// Video generation jobs. Video is async at the upstream: submit returns a
// task id, then a poller checks /v2/videos/tasks until the signed COS mp4 URL
// arrives. That URL expires in ~12h, so a background worker downloads the
// bytes to ./videos/{id}.mp4 and this table is the single source of truth
// clients read to know a job's state.
export const videoJobs = sqliteTable(
  "video_jobs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    // The account that owns the upstream task id. The poller re-uses this
    // account for every /v2/videos/tasks call — a different account's bearer
    // can't read someone else's task.
    accountId: integer("account_id").notNull(),
    accountLabel: text("account_label"),
    // Which client key paid for the job. Null on loopback or open-gateway
    // submits (same rule as api_keys usage accounting for chat).
    apiKeyId: integer("api_key_id"),
    // Upstream identifier ("v89546156-…"). Unique per submit.
    taskId: text("task_id").notNull(),
    // queued | in_progress | completed | failed
    status: text("status", { mode: "text" }).notNull().default("queued"),
    params: text("params", { mode: "json" })
      .$type<{
        prompt: string;
        seconds: number;
        resolution: "720P" | "1080P";
        aspectRatio: "16:9" | "9:16" | "1:1";
        audio: boolean;
        negativePrompt: string;
        watermark: boolean;
      }>()
      .notNull(),
    // On-disk path once the worker has fetched the mp4. Null while pending.
    filePath: text("file_path"),
    fileSize: integer("file_size"),
    // Last-known signed COS URL from upstream. Kept for debugging; download
    // clients get /v1/videos/:id/download from disk instead.
    videoUrl: text("video_url"),
    // Upstream-reported cost (usage.credit) and gateway-side USD estimate.
    creditUsed: real("credit_used"),
    dollarCost: real("dollar_cost"),
    errorMessage: text("error_message"),
    // Links to the request_logs row written at submit time so the Requests
    // page can jump between the two views.
    requestLogId: integer("request_log_id"),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer("updated_at", { mode: "timestamp" }),
    completedAt: integer("completed_at", { mode: "timestamp" }),
  },
  (t) => [
    // Poller sweep: find pending jobs oldest first.
    index("idx_video_jobs_status_created").on(t.status, t.createdAt),
    // Correlation: look up a job by upstream task id.
    index("idx_video_jobs_task").on(t.taskId),
  ]
);

// Singleton row for the dashboard login credential + its JWT signing secret.
// Zero rows means "no password configured yet" — the auth middleware treats
// that as open-gateway so a fresh install can reach /api/* to bootstrap.
// Rotating the JWT secret on every password change is how existing sessions
// get invalidated implicitly (their signature stops verifying).
export const dashboardAuth = sqliteTable("dashboard_auth", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  passwordHash: text("password_hash").notNull(),
  jwtSecret: text("jwt_secret").notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
});
