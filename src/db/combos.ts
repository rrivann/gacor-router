// DB access for model combos.
// A combo is a named ordered list of `provider/model` strings. When a client
// sends the combo name as its model, the router tries each entry in order
// until one succeeds — fallback routing that hides pool exhaustion from the
// client. Pattern ported from 9router's combos table.

import { desc, eq } from "drizzle-orm";
import { db } from "./index";
import { combos } from "./schema";

export interface Combo {
  id: number;
  name: string;
  models: string[];
  createdAt: Date;
  updatedAt: Date;
}

export function listCombos(): Combo[] {
  return db.select().from(combos).orderBy(desc(combos.id)).all() as Combo[];
}

export function getComboByName(name: string): Combo | undefined {
  return db.select().from(combos).where(eq(combos.name, name)).get() as
    | Combo
    | undefined;
}

export function getComboById(id: number): Combo | undefined {
  return db.select().from(combos).where(eq(combos.id, id)).get() as
    | Combo
    | undefined;
}

// Throws on unique-name conflict — caller handles the 409.
export function createCombo(name: string, models: string[]): Combo {
  const now = new Date();
  const row = db
    .insert(combos)
    .values({ name, models, createdAt: now, updatedAt: now })
    .returning()
    .get();
  return row as Combo;
}

export function updateCombo(
  id: number,
  patch: { name?: string; models?: string[] }
): Combo | undefined {
  const set: Record<string, unknown> = { updatedAt: new Date() };
  if (patch.name !== undefined) set.name = patch.name;
  if (patch.models !== undefined) set.models = patch.models;
  const row = db
    .update(combos)
    .set(set)
    .where(eq(combos.id, id))
    .returning()
    .get();
  return row as Combo | undefined;
}

export function deleteCombo(id: number): boolean {
  const r = db
    .delete(combos)
    .where(eq(combos.id, id))
    .returning({ id: combos.id })
    .get();
  return r !== undefined;
}
