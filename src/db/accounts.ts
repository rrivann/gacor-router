// DB access for the pool: account listing + KV settings.
// Reads are synchronous (bun-sqlite driver) so Pool can stay sync.

import { eq } from "drizzle-orm";
import { db } from "./index";
import { accounts, settings } from "./schema";
import { emit, EV_ACCOUNT_STATUS } from "../lib/events";
import type { AccountRow, RotationMode } from "../pool/pool";

export function listAccounts(provider: string): AccountRow[] {
  return db
    .select({
      id: accounts.id,
      provider: accounts.provider,
      label: accounts.label,
      secret: accounts.secret,
      creds: accounts.creds,
      status: accounts.status,
    })
    .from(accounts)
    .where(eq(accounts.provider, provider))
    .orderBy(accounts.id)
    .all();
}

export function setAccountStatus(id: number, status: string): void {
  db.update(accounts).set({ status }).where(eq(accounts.id, id)).run();
  emit(EV_ACCOUNT_STATUS, { id, status });
}

// Persist rotated credentials (e.g. after a token refresh) so later requests
// skip the round-trip and restarts keep the freshest tokens.
export function updateCreds(id: number, creds: Record<string, string>): void {
  db.update(accounts).set({ creds }).where(eq(accounts.id, id)).run();
}

export function getSetting(key: string): string | undefined {
  return db
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, key))
    .get()?.value;
}

export function setSetting(key: string, value: string): void {
  db.insert(settings)
    .values({ key, value })
    .onConflictDoUpdate({ target: settings.key, set: { value } })
    .run();
}

// Rotation mode per provider, e.g. setting `pool_rotation:codebuddy`.
export function rotationFor(provider: string): RotationMode {
  return getSetting(`pool_rotation:${provider}`) === "round-robin"
    ? "round-robin"
    : "sticky";
}

// ── Dashboard management ─────────────────────────────────────────
// Secrets are masked in list responses; the per-row reveal endpoint returns
// them verbatim for copy.

export interface AccountListRow {
  id: number;
  provider: string;
  label: string | null;
  status: string;
  createdAt: Date;
  hasSecret: boolean;
  credKeys: string[];
  usage: Record<string, unknown> | null;
  usageAt: Date | null;
}

export function listAllAccounts(provider?: string): AccountListRow[] {
  const rows = provider
    ? db.select().from(accounts).where(eq(accounts.provider, provider)).orderBy(accounts.id).all()
    : db.select().from(accounts).orderBy(accounts.id).all();
  return rows.map((r) => ({
    id: r.id,
    provider: r.provider,
    label: r.label,
    status: r.status,
    createdAt: r.createdAt,
    hasSecret: r.secret.length > 0 || Object.keys(r.creds ?? {}).length > 0,
    credKeys: Object.keys(r.creds ?? {}),
    usage: r.usageJson ?? null,
    usageAt: r.usageAt ?? null,
  }));
}

export function getAccount(id: number) {
  return db.select().from(accounts).where(eq(accounts.id, id)).get();
}

// Persist a freshly fetched usage snapshot.
export function updateUsage(id: number, usage: Record<string, unknown>): void {
  db.update(accounts).set({ usageJson: usage, usageAt: new Date() }).where(eq(accounts.id, id)).run();
}

export function createAccount(row: {
  provider: string;
  label?: string;
  secret?: string;
  creds?: Record<string, string>;
}): number {
  return db
    .insert(accounts)
    .values({
      provider: row.provider,
      label: row.label ?? null,
      secret: row.secret ?? "",
      creds: row.creds ?? null,
    })
    .returning({ id: accounts.id })
    .get().id;
}

export function deleteAccount(id: number): boolean {
  return db.delete(accounts).where(eq(accounts.id, id)).returning({ id: accounts.id }).get() !== undefined;
}

export function listSettings(): Record<string, string> {
  const rows = db.select().from(settings).all();
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

export function deleteSetting(key: string): boolean {
  return db.delete(settings).where(eq(settings.key, key)).returning({ key: settings.key }).get() !== undefined;
}
