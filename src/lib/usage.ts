// Usage fetching: pull a live credit snapshot from the provider's billing
// API through the provider interface, cache it on the account row. Shared by
// the list endpoint (stale-while-revalidate) and the explicit refresh.

import { registry } from "../providers";
import { getAccount, updateUsage } from "../db/accounts";
import type { Account, CreditUsage } from "../providers/types";

export class UsageError extends Error {
  constructor(
    message: string,
    readonly status: number = 502
  ) {
    super(message);
    this.name = "UsageError";
  }
}

function toAccount(row: NonNullable<ReturnType<typeof getAccount>>): Account {
  return {
    id: row.id,
    label: row.label ?? `#${row.id}`,
    secret: row.secret,
    creds: row.creds ?? {},
  };
}

// Fetch a live snapshot and persist it. Throws UsageError on any failure —
// the caller decides whether to serve the stale cache or surface the error.
export async function fetchAndCacheUsage(accountId: number): Promise<CreditUsage> {
  const row = getAccount(accountId);
  if (!row) throw new UsageError(`account #${accountId} not found`, 404);

  const provider = registry.get(row.provider);
  if (!provider) throw new UsageError(`provider "${row.provider}" is not implemented`, 501);
  if (!provider.usage) {
    throw new UsageError(`provider "${row.provider}" does not expose credit data`, 501);
  }

  try {
    const usage = await provider.usage(toAccount(row));
    updateUsage(accountId, usage as unknown as Record<string, unknown>);
    return usage;
  } catch (err) {
    if (err instanceof UsageError) throw err;
    throw new UsageError(err instanceof Error ? err.message : String(err));
  }
}
