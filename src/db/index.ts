// DB client — Bun native SQLite + Drizzle.

import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import * as schema from "./schema";
import { env } from "../lib/env";

export const sqlite = new Database(env.dbPath);
sqlite.exec("PRAGMA journal_mode = WAL;");

export const db = drizzle(sqlite, { schema });
export { schema };

// Additive-only runtime migrations for in-place upgrades. Drizzle owns the
// initial CREATE TABLE for fresh installs (via install.sh); this catches
// columns added later so an existing DB doesn't crash the boot. Called
// once at boot from src/index.ts. Idempotent — the PRAGMA is a single
// indexed read and the ALTER only fires when the column really is missing.
export function ensureSchema(): void {
  const migrations: { table: string; column: string; type: string }[] = [
    { table: "request_logs", column: "filters_applied", type: "TEXT" },
  ];
  for (const m of migrations) {
    const cols = new Set(
      sqlite
        .query<{ name: string }, []>(`PRAGMA table_info(${m.table})`)
        .all()
        .map((r) => r.name)
    );
    if (!cols.has(m.column)) {
      sqlite.exec(`ALTER TABLE ${m.table} ADD COLUMN ${m.column} ${m.type}`);
    }
  }
}
