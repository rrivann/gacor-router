// DB access for the pool: account listing + KV settings.
// Reads are synchronous (bun-sqlite driver) so Pool can stay sync.

import { eq } from "drizzle-orm";
import { db } from "./index";
import { accounts, settings } from "./schema";
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
