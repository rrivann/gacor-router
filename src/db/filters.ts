// Content-filter CRUD. Rows are ordered by `sort` then `id`, so the engine
// applies them in a stable, user-controllable sequence.

import { asc, eq } from "drizzle-orm";
import { db } from "./index";
import { contentFilters } from "./schema";

export interface ContentFilterRow {
  id: number;
  pattern: string;
  replacement: string;
  isRegex: boolean;
  isActive: boolean;
  sort: number;
  // null = apply to every provider. Non-empty array restricts to those names.
  providerScope: string[] | null;
  createdAt: Date;
}

export function listContentFilters(): ContentFilterRow[] {
  return db.select().from(contentFilters).orderBy(asc(contentFilters.sort), asc(contentFilters.id)).all();
}

export function createContentFilter(row: {
  pattern: string;
  replacement?: string;
  isRegex?: boolean;
  isActive?: boolean;
  sort?: number;
  providerScope?: string[] | null;
}): number {
  return db
    .insert(contentFilters)
    .values({
      pattern: row.pattern,
      replacement: row.replacement ?? "",
      isRegex: row.isRegex ?? false,
      isActive: row.isActive ?? true,
      sort: row.sort ?? 0,
      providerScope: row.providerScope ?? null,
    })
    .returning({ id: contentFilters.id })
    .get().id;
}

export function updateContentFilter(
  id: number,
  patch: Partial<Pick<ContentFilterRow, "pattern" | "replacement" | "isRegex" | "isActive" | "sort" | "providerScope">>
): boolean {
  const set: Record<string, unknown> = {};
  if (patch.pattern !== undefined) set.pattern = patch.pattern;
  if (patch.replacement !== undefined) set.replacement = patch.replacement;
  if (patch.isRegex !== undefined) set.isRegex = patch.isRegex;
  if (patch.isActive !== undefined) set.isActive = patch.isActive;
  if (patch.sort !== undefined) set.sort = patch.sort;
  if (patch.providerScope !== undefined) set.providerScope = patch.providerScope;
  if (Object.keys(set).length === 0) return false;
  const r = db.update(contentFilters).set(set).where(eq(contentFilters.id, id)).returning({ id: contentFilters.id }).get();
  return r !== undefined;
}

export function deleteContentFilter(id: number): boolean {
  return db.delete(contentFilters).where(eq(contentFilters.id, id)).returning({ id: contentFilters.id }).get() !== undefined;
}
