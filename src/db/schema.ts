// Drizzle schema. Started minimal; grows as features land.
// Conventions:
// - snake_case column names, camelCase TS fields
// - timestamps as integer unix ms via mode: "timestamp"

import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";

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
