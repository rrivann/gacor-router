// Drizzle schema. Started minimal; grows as features land.
// Conventions:
// - snake_case column names, camelCase TS fields
// - timestamps as integer unix ms via mode: "timestamp"

import { sqliteTable, text, integer, real, index } from "drizzle-orm/sqlite-core";

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
    // Upstream-reported credit cost (CodeBuddy usage event), when metered.
    // Fractional — a request can cost e.g. 0.57 credits.
    creditUsed: real("credit_used"),
    errorMessage: text("error_message"),
    requestBody: text("request_body"),
    responseBody: text("response_body"),
  },
  (t) => [
    index("idx_request_logs_created").on(t.createdAt),
    index("idx_request_logs_provider_created").on(t.provider, t.createdAt),
  ]
);
