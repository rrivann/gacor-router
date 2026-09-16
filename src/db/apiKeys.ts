// Client-facing API key CRUD + usage counters. Keys are stored plaintext (see
// schema note) and looked up by secret at auth time; the middleware caches
// hits for a few seconds so hot paths skip the DB.

import { asc, eq, sql } from "drizzle-orm";
import { db } from "./index";
import { apiKeys } from "./schema";

export interface ApiKeyRow {
  id: number;
  label: string;
  secret: string;
  enabled: boolean;
  tokenLimit: number;
  tokensUsed: number;
  maxConcurrent: number;
  expiresAt: Date | null;
  lastUsedAt: Date | null;
  allowedModels: string[] | null;
  allowedProviders: string[] | null;
  createdAt: Date;
}

export function countApiKeys(): number {
  const row = db.select({ n: sql<number>`count(*)` }).from(apiKeys).get();
  return row?.n ?? 0;
}

export function listApiKeys(): ApiKeyRow[] {
  return db.select().from(apiKeys).orderBy(asc(apiKeys.id)).all() as ApiKeyRow[];
}

export function getApiKey(id: number): ApiKeyRow | undefined {
  return db.select().from(apiKeys).where(eq(apiKeys.id, id)).get() as ApiKeyRow | undefined;
}

export function getApiKeyBySecret(secret: string): ApiKeyRow | undefined {
  return db.select().from(apiKeys).where(eq(apiKeys.secret, secret)).get() as ApiKeyRow | undefined;
}

export function createApiKey(row: {
  label: string;
  secret: string;
  enabled?: boolean;
  tokenLimit?: number;
  maxConcurrent?: number;
  expiresAt?: Date | null;
  allowedModels?: string[] | null;
  allowedProviders?: string[] | null;
}): number {
  return db
    .insert(apiKeys)
    .values({
      label: row.label,
      secret: row.secret,
      enabled: row.enabled ?? true,
      tokenLimit: row.tokenLimit ?? 0,
      maxConcurrent: row.maxConcurrent ?? 0,
      expiresAt: row.expiresAt ?? null,
      allowedModels: row.allowedModels ?? null,
      allowedProviders: row.allowedProviders ?? null,
    })
    .returning({ id: apiKeys.id })
    .get().id;
}

export function updateApiKey(
  id: number,
  patch: Partial<
    Pick<
      ApiKeyRow,
      | "label"
      | "enabled"
      | "tokenLimit"
      | "maxConcurrent"
      | "expiresAt"
      | "allowedModels"
      | "allowedProviders"
    >
  >
): boolean {
  const set: Record<string, unknown> = {};
  if (patch.label !== undefined) set.label = patch.label;
  if (patch.enabled !== undefined) set.enabled = patch.enabled;
  if (patch.tokenLimit !== undefined) set.tokenLimit = patch.tokenLimit;
  if (patch.maxConcurrent !== undefined) set.maxConcurrent = patch.maxConcurrent;
  if (patch.expiresAt !== undefined) set.expiresAt = patch.expiresAt;
  if (patch.allowedModels !== undefined) set.allowedModels = patch.allowedModels;
  if (patch.allowedProviders !== undefined) set.allowedProviders = patch.allowedProviders;
  if (Object.keys(set).length === 0) return false;
  const r = db.update(apiKeys).set(set).where(eq(apiKeys.id, id)).returning({ id: apiKeys.id }).get();
  return r !== undefined;
}

export function deleteApiKey(id: number): boolean {
  return db.delete(apiKeys).where(eq(apiKeys.id, id)).returning({ id: apiKeys.id }).get() !== undefined;
}

// Atomic increment. Called from the request-log tap after a successful
// upstream response so partial-write failures don't drain the quota.
export function addApiKeyUsage(id: number, tokens: number): void {
  if (tokens <= 0) return;
  db.update(apiKeys)
    .set({ tokensUsed: sql`${apiKeys.tokensUsed} + ${tokens}` })
    .where(eq(apiKeys.id, id))
    .run();
}

export function touchApiKeyLastUsed(id: number): void {
  db.update(apiKeys).set({ lastUsedAt: new Date() }).where(eq(apiKeys.id, id)).run();
}
