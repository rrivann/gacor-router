// Usage fetching: pull a live credit snapshot from the provider's billing
// API through the provider interface, cache it on the account row. Shared by
// the list endpoint (stale-while-revalidate) and the explicit refresh.

import { registry } from "../providers";
import { getAccount, setAccountStatus, updateCreds, updateUsage } from "../db/accounts";
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
    // Mint or rotate the access token first — an RT-only account has no
    // bearer yet, and a stale AT will 401 the billing endpoint. Persist the
    // new pair so the next request skips this round-trip.
    let acc = toAccount(row);
    if (provider.refresh) {
      const refreshed = await provider.refresh(acc);
      if (!refreshed) throw new UsageError("credential invalid — refresh rejected", 401);
      if (refreshed.creds !== acc.creds) updateCreds(accountId, refreshed.creds);
      acc = refreshed;
    }

    const usage = await provider.usage(acc);
    updateUsage(accountId, usage as unknown as Record<string, unknown>);
    // Reconcile status with the fresh snapshot: an account whose credit went
    // to zero should stop being picked before the next request wastes a
    // round-trip on a certain 429; one that refilled (cycle reset) should be
    // re-armed automatically. `banned` is a credential-level verdict, not a
    // credit one, so leave it alone.
    if (usage.remaining <= 0 && row.status === "active") {
      setAccountStatus(accountId, "exhausted");
    } else if (usage.remaining > 0 && row.status === "exhausted") {
      setAccountStatus(accountId, "active");
    }
    return usage;
  } catch (err) {
    if (err instanceof UsageError) throw err;
    throw new UsageError(err instanceof Error ? err.message : String(err));
  }
}
