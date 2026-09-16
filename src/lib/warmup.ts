// Account warmup (enowx-derived, slimmed): send a real probe request to the
// upstream on a cheap model to verify the account is alive, update its pool
// status from the outcome, and refresh the credit snapshot when the provider
// exposes billing. Also used inline on account creation.

import { registry } from "../providers";
import { getAccount, listAccounts, setAccountStatus, updateLabel } from "../db/accounts";
import { insertRequestLog } from "../db/logs";
import { fetchAndCacheUsage, UsageError } from "./usage";
import { deriveLabel } from "./label";
import { emit, EV_ACCOUNT_STATUS, EV_REQUEST_LOG } from "./events";
import type { Account, Outcome } from "../providers/types";

// A valid, cheap model accepted by each provider's upstream — enowx probes
// CodeBuddy with glm-5.2, which answers with a zero-credit usage block.
const WARMUP_MODEL: Record<string, string> = {
  codebuddy: "glm-5.2",
};

// Providers like CodeBuddy reject a probe without a system turn (11128).
const WARMUP_SYSTEM = "You are a helpful assistant.";

export interface WarmResult {
  ok: boolean;
  outcome: Outcome | "error";
  status: string;
  latencyMs: number;
  credit?: { remaining: number; limit: number };
  error?: string;
}

function toAccount(row: NonNullable<ReturnType<typeof getAccount>>): Account {
  return {
    id: row.id,
    label: row.label ?? `#${row.id}`,
    secret: row.secret,
    creds: row.creds ?? {},
  };
}

// Probe one account. Never throws — failures become the result's error field.
export async function warmAccount(
  accountId: number,
  opts: { fetch?: typeof globalThis.fetch; refreshCredit?: boolean } = {}
): Promise<WarmResult> {
  const startedAt = Date.now();
  const row = getAccount(accountId);
  if (!row) return { ok: false, outcome: "error", status: "unknown", latencyMs: 0, error: `account #${accountId} not found` };

  const provider = registry.get(row.provider);
  if (!provider) {
    return { ok: false, outcome: "error", status: row.status, latencyMs: 0, error: `provider "${row.provider}" is not implemented` };
  }

  const model = WARMUP_MODEL[row.provider];
  if (!model) {
    return { ok: false, outcome: "error", status: row.status, latencyMs: 0, error: `no warmup model configured for "${row.provider}"` };
  }

  const doFetch = opts.fetch ?? globalThis.fetch;
  let acc = toAccount(row);

  // Renew the credential first when the provider can — probing with a stale
  // token would misreport a dead account.
  if (provider.refresh) {
    const refreshed = await provider.refresh(acc);
    if (refreshed) acc = refreshed;
  }

  // Backfill a JWT-derived label once the AT is available. Only fires when
  // the row still has no user-set label, so a renamed account is preserved.
  if (!row.label) {
    const derived = deriveLabel(acc.creds);
    if (derived) {
      updateLabel(acc.id, derived);
      acc = { ...acc, label: derived };
    }
  }

  // Build the probe the same way a real request is built, then classify the
  // response with the provider's own logic — that keeps warmup outcome and
  // pool reaction perfectly aligned.
  let outcome: Outcome;
  let errBody = "";
  try {
    const upstream = await provider.buildRequest(
      {
        model,
        stream: false,
        messages: [
          { role: "system", parts: [{ type: "text", text: WARMUP_SYSTEM }] },
          { role: "user", parts: [{ type: "text", text: "hi" }] },
        ],
      },
      acc
    );
    const resp = await doFetch(upstream);
    const body = await resp.text();
    outcome = provider.classify(resp.status, body);
    errBody = body.slice(0, 200);
  } catch (err) {
    return {
      ok: false,
      outcome: "error",
      status: row.status,
      latencyMs: Date.now() - startedAt,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  // Reflect the outcome onto the pool the same way the proxy would — transient
  // failures don't change status (the account isn't at fault).
  let status = row.status;
  if (outcome === "dead") {
    setAccountStatus(acc.id, "banned");
    status = "banned";
  } else if (outcome === "exhausted") {
    setAccountStatus(acc.id, "exhausted");
    status = "exhausted";
  } else if (outcome === "ok" && row.status !== "active") {
    // A good probe is direct proof the credential works — re-arm both
    // exhausted and banned accounts. This is also the recovery path when a
    // ban was misclassified (e.g. a stale snapshot or a past bug).
    setAccountStatus(acc.id, "active");
    status = "active";
  }

  const result: WarmResult = {
    ok: outcome === "ok",
    outcome,
    status,
    latencyMs: Date.now() - startedAt,
  };
  if (outcome !== "ok") result.error = `probe failed: ${errBody || outcome}`;

  // Record the probe in the request log (source="warmup") so it's visible in
  // Requests alongside client traffic, but distinguishable from it.
  const logId = insertRequestLog({
    provider: row.provider,
    model,
    accountId: acc.id,
    accountLabel: acc.label,
    stream: false,
    source: "warmup",
    status: outcome === "ok" ? "success" : "error",
    outcome,
    durationMs: Date.now() - startedAt,
    errorMessage: outcome === "ok" ? null : (errBody.slice(0, 300) || outcome),
    responseBody: errBody.slice(0, 2048) || null,
  });
  emit(EV_REQUEST_LOG, {
    id: logId,
    provider: row.provider,
    model,
    accountId: acc.id,
    accountLabel: acc.label,
    status: outcome === "ok" ? "success" : "error",
    source: "warmup",
    durationMs: Date.now() - startedAt,
    errorMessage: outcome === "ok" ? null : outcome,
  });

  // Refresh the credit snapshot on success when the provider meters it.
  if (opts.refreshCredit !== false && outcome === "ok" && provider.usage) {
    try {
      const usage = await fetchAndCacheUsage(acc.id);
      result.credit = { remaining: usage.remaining, limit: usage.limit };
    } catch (err) {
      // Credit refresh is best-effort — the probe already answered the
      // important question (is the account alive?).
      if (err instanceof UsageError) result.error = undefined;
    }
  }

  return result;
}

// Warm every account for a provider (optionally filtered by status). Runs
// sequentially — warmup is background traffic and shouldn't hammer upstream.
export async function warmAll(
  provider: string,
  opts: { statuses?: string[]; fetch?: typeof globalThis.fetch } = {}
): Promise<{ total: number; ok: number; results: { id: number; ok: boolean; status: string }[] }> {
  const rows = listAccounts(provider).filter((a) => a.status !== "banned" || !opts.statuses);
  const wanted = opts.statuses ?? ["active", "exhausted"];
  const targets = rows.filter((a) => wanted.includes(a.status));

  const results: { id: number; ok: boolean; status: string }[] = [];
  let ok = 0;
  for (const a of targets) {
    const r = await warmAccount(a.id, opts);
    if (r.ok) ok++;
    results.push({ id: a.id, ok: r.ok, status: r.status });
    emit(EV_ACCOUNT_STATUS, { id: a.id, status: r.status });
  }
  return { total: targets.length, ok, results };
}
