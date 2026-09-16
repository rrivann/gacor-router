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
  },
  (t) => [
    index("idx_request_logs_created").on(t.createdAt),
    index("idx_request_logs_provider_created").on(t.provider, t.createdAt),
  ]
);
