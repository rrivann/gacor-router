import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Eye, EyeOff, Plus, RefreshCw, Search, Trash2, Copy, Check, ArrowLeft, Flame, Loader2 } from "lucide-react";
import { Card } from "../components/ui/card";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Input, Textarea } from "../components/ui/input";
import { Dialog } from "../components/ui/dialog";
import {
  createAccount,
  deleteAccount,
  fetchAccounts,
  fetchSettings,
  revealAccount,
  saveSettings,
  setAccountStatus,
  refreshUsage,
  warmAccount,
  warmAll,
  type AccountRow,
} from "../lib/api";
import { formatDateTime, cn, detectCredentialType } from "../lib/utils";
import { useTimedMessage } from "../hooks/useTimedMessage";
import { useWsEvent } from "../hooks/useWebSocket";
import { CreditCell } from "../components/accounts/CreditCell";
import { ProviderCards } from "../components/accounts/ProviderCards";
import { ProviderSettingsModal } from "../components/accounts/ProviderSettingsModal";
import { ProviderIcon } from "../components/accounts/ProviderIcon";

type BadgeVariant = "success" | "warning" | "error" | "secondary";
const statusVariant: Record<string, BadgeVariant> = {
  active: "success",
  exhausted: "warning",
  banned: "error",
};

export default function Accounts() {
  const [accounts, setAccounts] = useState<AccountRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  // Drill-down state lives in the URL (?provider=codebuddy) so clicking the
  // sidebar "Accounts" link — which navigates to bare /accounts without a
  // query — resets us to the landing view instead of getting stuck in a
  // drill-down. Also makes the drill-down URL shareable/bookmarkable.
  const [searchParams, setSearchParams] = useSearchParams();
  const providerFilter = searchParams.get("provider") ?? "all";
  const setProviderFilter = useCallback((p: string) => {
    if (p === "all") {
      setSearchParams({}, { replace: true });
    } else {
      setSearchParams({ provider: p }, { replace: true });
    }
  }, [setSearchParams]);
  const [statusFilter, setStatusFilter] = useState("all");
  const [rotation, setRotation] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const { message, setMessage, clearMessage } = useTimedMessage<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [addProvider, setAddProvider] = useState("codebuddy");
  const [settingsProvider, setSettingsProvider] = useState<string | null>(null);
  const [warming, setWarming] = useState<Record<number, boolean>>({});
  const [warmingAll, setWarmingAll] = useState(false);
  const [revealed, setRevealed] = useState<Record<number, string>>({});
  const [copied, setCopied] = useState<number | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{ id: number; label: string } | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [retryingProvider, setRetryingProvider] = useState<Record<string, boolean>>({});
  const [warmingProvider, setWarmingProvider] = useState<Record<string, boolean>>({});

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [accs, settings] = await Promise.all([fetchAccounts(), fetchSettings()]);
      setAccounts(accs.data);
      const rot: Record<string, string> = {};
      for (const [k, v] of Object.entries(settings.data)) {
        if (k.startsWith("pool_rotation:")) rot[k.slice("pool_rotation:".length)] = v;
      }
      setRotation(rot);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useWsEvent("account_status", () => load());

  // Always surface the built-in providers even if the pool is empty — the
  // etteum pattern: user sees a CodeBuddy card straight away and clicks its
  // Add button to fill it. Providers derived from actual rows are unioned in
  // so third-party ones (if the user ever adds them) show up too.
  const KNOWN_PROVIDERS = ["codebuddy"];
  const providers = [
    ...new Set([...KNOWN_PROVIDERS, ...accounts.map((a) => a.provider)]),
  ].sort();

  // Status counts for the drill-down pills (scoped to the picked provider).
  const inProvider = providerFilter === "all" ? accounts : accounts.filter((a) => a.provider === providerFilter);
  const statusCounts: Record<string, number> = { all: inProvider.length };
  for (const a of inProvider) statusCounts[a.status] = (statusCounts[a.status] ?? 0) + 1;

  const filtered = inProvider.filter((a) => {
    if (statusFilter !== "all" && a.status !== statusFilter) return false;
    const q = search.toLowerCase();
    return (
      !q ||
      a.provider.toLowerCase().includes(q) ||
      (a.label ?? "").toLowerCase().includes(q) ||
      String(a.id).includes(q)
    );
  });

  // Entering a provider resets the narrower filters.
  function selectProvider(p: string) {
    setProviderFilter(p);
    setStatusFilter("all");
    setSearch("");
  }

  function ok(text: string) {
    setMessage(text);
    setError(null);
  }
  function fail(err: unknown) {
    setError(err instanceof Error ? err.message : String(err));
    clearMessage();
  }

  async function handleStatus(id: number, status: string) {
    try {
      await setAccountStatus(id, status);
      ok(`#${id} → ${status}`);
      await load();
    } catch (err) {
      fail(err);
    }
  }

  function askDelete(id: number, label: string | null) {
    setDeleteTarget({ id, label: label ?? `#${id}` });
  }

  async function confirmDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await deleteAccount(deleteTarget.id);
      ok(`Deleted ${deleteTarget.label}`);
      setDeleteTarget(null);
      await load();
    } catch (err) {
      fail(err);
    } finally {
      setDeleting(false);
    }
  }

  async function handleReveal(id: number) {
    if (revealed[id]) {
      setRevealed((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
      return;
    }
    try {
      const r = await revealAccount(id);
      const text = r.creds.access_token || r.secret || JSON.stringify(r.creds);
      setRevealed((prev) => ({ ...prev, [id]: text }));
    } catch (err) {
      fail(err);
    }
  }

  async function handleCopy(id: number) {
    const text = revealed[id];
    if (!text) return;
    await navigator.clipboard.writeText(text);
    setCopied(id);
    setTimeout(() => setCopied(null), 1500);
  }

  async function handleRotation(provider: string, roundRobin: boolean) {
    const mode = roundRobin ? "round-robin" : "sticky";
    try {
      await saveSettings({ [`pool_rotation:${provider}`]: mode });
      setRotation((prev) => ({ ...prev, [provider]: mode }));
      ok(`${provider} rotation → ${mode}`);
    } catch (err) {
      fail(err);
    }
  }

  async function handleRefreshUsage(id: number) {
    try {
      const { data } = await refreshUsage(id);
      setAccounts((prev) =>
        prev.map((a) => (a.id === id ? { ...a, usage: data, usageAt: new Date().toISOString() } : a))
      );
    } catch (err) {
      fail(err);
      throw err; // CreditCell shows its own inline error too
    }
  }

  // Header Refresh: reload the accounts list AND fan out a credit refresh for
  // every account in the current provider scope. Silent per-account failure
  // (a dead credential) — the list reload still runs and surfaces status.
  async function handleRefreshAll() {
    const ids = inProvider.map((a) => a.id);
    await Promise.allSettled(ids.map((id) => refreshUsage(id)));
    await load();
  }

  // Card-scoped warmup: probe every account of one provider. Uses the same
  // warmAll endpoint the drill-down toolbar hits, so behavior stays identical.
  async function handleProviderWarm(provider: string) {
    setWarmingProvider((prev) => ({ ...prev, [provider]: true }));
    try {
      const r = await warmAll(provider);
      ok(`Warmed ${r.ok}/${r.total} ${provider} accounts`);
      await load();
    } catch (err) {
      fail(err);
    } finally {
      setWarmingProvider((prev) => {
        const next = { ...prev };
        delete next[provider];
        return next;
      });
    }
  }

  // Card-scoped retry: refresh credit for every account of one provider.
  // Useful once the pool holds several providers so a single stale card can
  // be re-checked without hammering everyone.
  async function handleProviderRetry(provider: string) {
    const ids = accounts.filter((a) => a.provider === provider).map((a) => a.id);
    if (ids.length === 0) return;
    setRetryingProvider((prev) => ({ ...prev, [provider]: true }));
    try {
      await Promise.allSettled(ids.map((id) => refreshUsage(id)));
      await load();
    } finally {
      setRetryingProvider((prev) => {
        const next = { ...prev };
        delete next[provider];
        return next;
      });
    }
  }

  async function handleWarm(id: number) {
    setWarming((w) => ({ ...w, [id]: true }));
    try {
      const r = await warmAccount(id);
      if (r.ok) ok(`#${id} warm — ${r.status}${r.credit ? ` · ${r.credit.remaining}/${r.credit.limit} credits` : ""}`);
      else fail(new Error(`#${id} probe failed (${r.outcome})${r.error ? `: ${r.error}` : ""}`));
      await load();
    } catch (err) {
      fail(err);
    } finally {
      setWarming((w) => ({ ...w, [id]: false }));
    }
  }

  async function handleWarmAll() {
    if (providerFilter === "all") return;
    setWarmingAll(true);
    try {
      const r = await warmAll(providerFilter);
      ok(`Warmed ${r.ok}/${r.total} ${providerFilter} accounts`);
      await load();
    } catch (err) {
      fail(err);
    } finally {
      setWarmingAll(false);
    }
  }

  return (
    <div className="space-y-6">
      {providerFilter === "all" ? (
        /* ── Landing: page header + provider cards ── */
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h1 className="text-2xl font-bold">Accounts</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Upstream credentials in the pool
            </p>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={handleRefreshAll} disabled={loading}>
              <RefreshCw className="h-4 w-4" /> Refresh
            </Button>
          </div>
        </div>
      ) : (
        /* ── Drill-down: breadcrumb header ala enowx/etteum ── */
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-2">
            <button
              onClick={() => selectProvider("all")}
              className="rounded-md p-1.5 text-muted-foreground hover:bg-secondary hover:text-foreground"
              title="Back to providers"
            >
              <ArrowLeft className="h-4 w-4" />
            </button>
            <ProviderIcon provider={providerFilter} size={28} />
            <div>
              <h1 className="flex items-baseline gap-2 text-xl font-bold capitalize">
                {providerFilter}
                <span className="text-sm font-normal text-muted-foreground">
                  {inProvider.length} {inProvider.length === 1 ? "account" : "accounts"}
                </span>
              </h1>
              <p className="text-xs text-muted-foreground">Accounts / {providerFilter}</p>
            </div>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={handleRefreshAll} disabled={loading}>
              <RefreshCw className="h-4 w-4" /> Refresh
            </Button>
            <Button variant="outline" size="sm" onClick={handleWarmAll} disabled={warmingAll}>
              {warmingAll ? <Loader2 className="h-4 w-4 animate-spin" /> : <Flame className="h-4 w-4" />}
              Warmup All
            </Button>
            <Button size="sm" onClick={() => { setAddProvider(providerFilter); setShowAdd(true); }}>
              <Plus className="h-4 w-4" /> Add account
            </Button>
          </div>
        </div>
      )}

      {message && (
        <div className="rounded-md border border-success/30 bg-success/10 px-3 py-2 text-sm text-success">
          {message}
        </div>
      )}
      {error && (
        <div className="rounded-md border border-error/30 bg-error/10 px-3 py-2 text-sm text-error">
          {error}
        </div>
      )}

      {providerFilter === "all" ? (
        /* Provider summary cards (click drills in, gear toggles rotation).
           Always render — a card for each known provider surfaces even when
           the pool is empty, so the user can hit Add without scanning for a
           different affordance. */
        <ProviderCards
          providers={providers}
          accounts={accounts}
          selected={providerFilter}
          rotation={rotation}
          retrying={retryingProvider}
          warming={warmingProvider}
          onSelect={selectProvider}
          onAdd={(p) => {
            setAddProvider(p);
            setShowAdd(true);
          }}
          onRetry={handleProviderRetry}
          onWarm={handleProviderWarm}
          onOpenSettings={setSettingsProvider}
        />
      ) : (
        <>
          {/* Status filter pills (etteum) + search */}
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
            <div className="flex flex-wrap items-center gap-1.5">
              {["all", "active", "exhausted", "banned"].map((s) => {
                const n = statusCounts[s] ?? 0;
                const activePill = statusFilter === s;
                return (
                  <button
                    key={s}
                    onClick={() => setStatusFilter(s)}
                    className={cn(
                      "rounded-md border px-2.5 py-1 text-xs capitalize transition-colors",
                      activePill
                        ? "border-primary/50 bg-primary/15 text-primary"
                        : "border-border text-secondary-foreground hover:bg-secondary hover:text-foreground"
                    )}
                  >
                    {s} <span className="tabular-nums opacity-70">({n})</span>
                  </button>
                );
              })}
            </div>
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={`Search ${providerFilter} accounts…`}
                className="pl-9"
              />
            </div>
          </div>

          <Card>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                    <th className="px-4 py-3">#</th>
                    <th className="px-4 py-3">Provider</th>
                    <th className="px-4 py-3">Label</th>
                    <th className="px-4 py-3">Status</th>
                    <th className="px-4 py-3">Credit</th>
                    <th className="px-4 py-3">Credential</th>
                    <th className="px-4 py-3">Created</th>
                    <th className="px-4 py-3 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.length === 0 && (
                    <tr>
                      <td colSpan={8} className="px-4 py-12">
                        {loading ? (
                          <div className="text-center text-muted-foreground">Loading…</div>
                        ) : (
                          <div className="mx-auto max-w-md space-y-3 text-center">
                            <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-full bg-secondary text-muted-foreground">
                              <Plus className="h-4 w-4" />
                            </div>
                            <div>
                              <div className="text-sm font-medium">No {providerFilter} accounts yet</div>
                              <p className="mt-1 text-xs text-muted-foreground">
                                Paste a refresh token (<code className="rounded bg-secondary px-1 py-0.5 text-[10px]">eyJ…</code>) or an api_key (<code className="rounded bg-secondary px-1 py-0.5 text-[10px]">ck_…</code>). Type auto-detected.
                              </p>
                            </div>
                            <Button size="sm" onClick={() => { setAddProvider(providerFilter); setShowAdd(true); }}>
                              <Plus className="h-4 w-4" /> Add {providerFilter} account
                            </Button>
                          </div>
                        )}
                      </td>
                    </tr>
                  )}
                  {filtered.map((a, i) => (
                    <tr key={a.id} className="border-b border-border/60 last:border-0 hover:bg-secondary/40">
                  <td className="px-4 py-2.5 tabular-nums text-muted-foreground" title={`db id ${a.id}`}>{i + 1}</td>
                  <td className="px-4 py-2.5 font-medium">{a.provider}</td>
                  <td className="px-4 py-2.5">{a.label ?? "—"}</td>
                  <td className="px-4 py-2.5">
                    <Badge variant={statusVariant[a.status] ?? "secondary"}>{a.status}</Badge>
                  </td>
                  <td className="px-4 py-2.5">
                    <CreditCell usage={a.usage} usageAt={a.usageAt} onRefresh={() => handleRefreshUsage(a.id)} />
                  </td>
                  <td className="max-w-[220px] px-4 py-2.5">
                    {revealed[a.id] ? (
                      <div className="flex items-center gap-1">
                        <code className="truncate rounded bg-secondary px-1.5 py-0.5 text-xs">
                          {revealed[a.id]}
                        </code>
                        <Button variant="ghost" size="icon" onClick={() => handleCopy(a.id)} aria-label="Copy">
                          {copied === a.id ? (
                            <Check className="h-3.5 w-3.5 text-success" />
                          ) : (
                            <Copy className="h-3.5 w-3.5" />
                          )}
                        </Button>
                      </div>
                    ) : (
                      <span className="text-xs text-muted-foreground">
                        {a.credKeys.length > 0 ? a.credKeys.join(", ") : a.hasSecret ? "secret" : "—"}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-xs text-muted-foreground">{formatDateTime(a.createdAt)}</td>
                  <td className="px-4 py-2.5">
                    <div className="flex items-center justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => handleWarm(a.id)}
                        disabled={warming[a.id]}
                        aria-label="Warmup"
                        title="Warmup — probe this account (status + credit)"
                      >
                        {warming[a.id] ? (
                          <Loader2 className="h-4 w-4 animate-spin text-warning" />
                        ) : (
                          <Flame className="h-4 w-4 text-warning" />
                        )}
                      </Button>
                      <Button variant="ghost" size="icon" onClick={() => handleReveal(a.id)} aria-label="Reveal">
                        {revealed[a.id] ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                      </Button>
                      {a.status !== "active" && (
                        <Button variant="outline" size="sm" onClick={() => handleStatus(a.id, "active")}>
                          Reactivate
                        </Button>
                      )}
                      {a.status === "active" && (
                        <Button variant="outline" size="sm" onClick={() => handleStatus(a.id, "exhausted")}>
                          Pause
                        </Button>
                      )}
                      <Button variant="ghost" size="icon" onClick={() => askDelete(a.id, a.label)} aria-label="Delete">
                        <Trash2 className="h-4 w-4 text-error" />
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
                </tbody>
              </table>
            </div>
          </Card>
        </>
      )}

      {settingsProvider && (
        <ProviderSettingsModal
          provider={settingsProvider}
          rotation={rotation[settingsProvider]}
          accounts={accounts}
          onRotationChange={handleRotation}
          onClose={() => setSettingsProvider(null)}
          onError={fail}
        />
      )}

      <AddAccountDialog
        open={showAdd}
        initialProvider={addProvider}
        existingAccounts={accounts}
        onClose={() => setShowAdd(false)}
        onCreated={async () => {
          setShowAdd(false);
          ok("Account created");
          await load();
        }}
        onReload={load}
        onError={fail}
      />

      <Dialog
        open={deleteTarget !== null}
        onClose={() => !deleting && setDeleteTarget(null)}
        title="Delete account"
      >
        <div className="space-y-4">
          <p className="text-sm">
            Delete <span className="font-medium">{deleteTarget?.label}</span>? This cannot be undone.
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="outline" size="sm" onClick={() => setDeleteTarget(null)} disabled={deleting}>
              Cancel
            </Button>
            <Button size="sm" onClick={confirmDelete} disabled={deleting}>
              {deleting ? "Deleting…" : "Delete"}
            </Button>
          </div>
        </div>
      </Dialog>
    </div>
  );
}

// Decode a JWT payload for client-side dedup. Same shape as the backend
// helper; kept inline here to avoid pulling node:Buffer into the browser bundle.
function decodeJwtSub(token: string): string | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const b64 = parts[1]!.replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64 + "===".slice((b64.length + 3) % 4);
    const payload = JSON.parse(atob(padded)) as { sub?: unknown };
    return typeof payload.sub === "string" && payload.sub.length > 0 ? payload.sub : null;
  } catch {
    return null;
  }
}

function AddAccountDialog({
  open,
  initialProvider,
  existingAccounts,
  onClose,
  onCreated,
  onReload,
  onError,
}: {
  open: boolean;
  initialProvider: string;
  existingAccounts: AccountRow[];
  onClose: () => void;
  onCreated: () => void;
  onReload: () => void;
  onError: (err: unknown) => void;
}) {
  const [provider, setProvider] = useState(initialProvider);
  const [label, setLabel] = useState("");
  const [refreshToken, setRefreshToken] = useState("");
  const [bulkTokens, setBulkTokens] = useState("");
  const [mode, setMode] = useState<"single" | "bulk">("single");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{
    done: number;
    total: number;
    failed: { rt: string; err: string }[];
    skipped: { rt: string; reason: string }[];
  } | null>(null);

  // A card's "+ Add account" preselects its provider for the next open.
  // Also clears the token/label fields so a submitted secret doesn't linger.
  useEffect(() => {
    if (open) {
      setProvider(initialProvider);
      setLabel("");
      setRefreshToken("");
      setBulkTokens("");
      setMode("single");
      setProgress(null);
    }
  }, [open, initialProvider]);

  async function submitSingle() {
    setBusy(true);
    try {
      const token = refreshToken.trim();
      if (!token) return;
      // Auto-detect from the token's shape: "ck_" is a CodeBuddy api_key
      // (used as-is, no refresh), anything else is treated as a refresh_token
      // (JWT that the provider exchanges for a fresh access token).
      const kind = detectCredentialType(token);
      const creds: Record<string, string> =
        kind === "api_key" ? { api_key: token } : { refresh_token: token };
      await createAccount({
        provider: provider.trim(),
        label: label.trim() || undefined,
        creds,
      });
      onCreated();
    } catch (err) {
      onError(err);
    } finally {
      setBusy(false);
    }
  }

  async function submitBulk() {
    const raw = bulkTokens
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (raw.length === 0) return;

    // Frontend pre-filter: only dedup against duplicates within the paste
    // itself (RT string + JWT sub + api_key string). The list endpoint doesn't
    // expose token values, so pool-scope dedup is the backend's job — it
    // returns 409 and we surface that as "skipped" below. Mixed input works
    // out of the box: each line is detected independently.
    void existingAccounts;
    const seenRts = new Set<string>();
    const seenApiKeys = new Set<string>();
    const seenSubs = new Set<string>();

    setBusy(true);
    const failed: { rt: string; err: string }[] = [];
    const skipped: { rt: string; reason: string }[] = [];
    setProgress({ done: 0, total: raw.length, failed, skipped });

    for (let i = 0; i < raw.length; i++) {
      const token = raw[i]!;
      const kind = detectCredentialType(token);

      if (kind === "api_key") {
        if (seenApiKeys.has(token)) {
          skipped.push({ rt: token, reason: "duplicate api_key in paste" });
          setProgress({ done: i + 1, total: raw.length, failed: [...failed], skipped: [...skipped] });
          continue;
        }
        try {
          await createAccount({
            provider: provider.trim(),
            creds: { api_key: token },
          });
          seenApiKeys.add(token);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (msg.includes("already used") || msg.includes("same upstream identity")) {
            skipped.push({ rt: token, reason: msg });
          } else {
            failed.push({ rt: token, err: msg });
          }
        }
        setProgress({ done: i + 1, total: raw.length, failed: [...failed], skipped: [...skipped] });
        continue;
      }

      // refresh_token path (JWT) — unchanged.
      if (seenRts.has(token)) {
        skipped.push({ rt: token, reason: "duplicate line in paste" });
        setProgress({ done: i + 1, total: raw.length, failed: [...failed], skipped: [...skipped] });
        continue;
      }
      const sub = decodeJwtSub(token);
      if (sub && seenSubs.has(sub)) {
        skipped.push({ rt: token, reason: "same JWT sub as earlier line" });
        setProgress({ done: i + 1, total: raw.length, failed: [...failed], skipped: [...skipped] });
        continue;
      }
      try {
        await createAccount({
          provider: provider.trim(),
          creds: { refresh_token: token },
        });
        seenRts.add(token);
        if (sub) seenSubs.add(sub);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // Backend's 409 for duplicates is expected — surface as "skipped", not "failed".
        if (msg.includes("already used") || msg.includes("same upstream identity")) {
          skipped.push({ rt: token, reason: msg });
        } else {
          failed.push({ rt: token, err: msg });
        }
      }
      setProgress({ done: i + 1, total: raw.length, failed: [...failed], skipped: [...skipped] });
    }
    setBusy(false);
    // All clean → close dialog. Otherwise refresh the list in the background
    // but keep the panel open so the user can see what was skipped/failed.
    if (failed.length === 0 && skipped.length === 0) {
      onCreated();
    } else {
      onReload();
    }
  }

  return (
    <Dialog open={open} onClose={onClose} title="Add Account">
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <label className="space-y-1 text-sm">
            <span className="text-xs text-muted-foreground">Provider</span>
            <Input value={provider} onChange={(e) => setProvider(e.target.value)} placeholder="codebuddy" />
          </label>
          <label className="space-y-1 text-sm">
            <span className="text-xs text-muted-foreground">Label (optional)</span>
            <Input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder={mode === "bulk" ? "auto-derived from JWT" : "my-account"}
              disabled={mode === "bulk"}
            />
          </label>
        </div>

        <div className="flex gap-2">
          <Button
            variant={mode === "single" ? "default" : "outline"}
            size="sm"
            onClick={() => setMode("single")}
            disabled={busy}
          >
            Single
          </Button>
          <Button
            variant={mode === "bulk" ? "default" : "outline"}
            size="sm"
            onClick={() => setMode("bulk")}
            disabled={busy}
          >
            Bulk
          </Button>
        </div>

        {mode === "single" ? (
          <label className="block space-y-1 text-sm">
            <span className="text-xs text-muted-foreground">
              refresh_token or api_key
              {refreshToken.trim() && (
                <span className="ml-2 rounded bg-secondary px-1.5 py-0.5 text-[10px] uppercase tracking-wide">
                  detected: {detectCredentialType(refreshToken)}
                </span>
              )}
            </span>
            <Input value={refreshToken} onChange={(e) => setRefreshToken(e.target.value)} placeholder="eyJhbGc… or ck_…" />
            <span className="text-xs text-muted-foreground">
              JWT refresh tokens are auto-refreshed; opaque api_keys (prefix <code className="rounded bg-secondary px-1 py-0.5 text-[10px]">ck_</code>) are used as-is.
            </span>
          </label>
        ) : (
          <label className="block space-y-1 text-sm">
            <span className="text-xs text-muted-foreground">tokens (one per line — mixed refresh_token + api_key ok)</span>
            <Textarea
              value={bulkTokens}
              onChange={(e) => setBulkTokens(e.target.value)}
              placeholder={"eyJhbGc…rt1\nck_fug2b9…apikey\neyJhbGc…rt2"}
              className="min-h-32 font-mono text-xs"
            />
            <span className="text-xs text-muted-foreground">
              Each line becomes one account. Type auto-detected from the prefix (<code className="rounded bg-secondary px-1 py-0.5 text-[10px]">ck_</code> = api_key, else refresh_token).
            </span>
          </label>
        )}

        {progress && (
          <div className="rounded-md border border-border bg-secondary/40 p-3 text-xs">
            <div className="mb-1 flex items-center justify-between">
              <span className="font-medium">
                Progress: {progress.done} / {progress.total}
              </span>
              <span className="text-muted-foreground">
                {progress.done - progress.failed.length - progress.skipped.length} ok ·{" "}
                {progress.skipped.length} skipped · {progress.failed.length} failed
              </span>
            </div>
            <div className="h-1 w-full overflow-hidden rounded-full bg-secondary">
              <div
                className="h-full rounded-full bg-primary transition-[width]"
                style={{ width: `${(progress.done / progress.total) * 100}%` }}
              />
            </div>
            {(progress.skipped.length > 0 || progress.failed.length > 0) && (
              <div className="mt-2 space-y-0.5 max-h-32 overflow-auto">
                {progress.skipped.map((s, i) => (
                  <div key={`s${i}`} className="text-warning">
                    <code className="font-mono">…{s.rt.slice(-12)}</code>: skipped ({s.reason})
                  </div>
                ))}
                {progress.failed.map((f, i) => (
                  <div key={`f${i}`} className="text-error">
                    <code className="font-mono">…{f.rt.slice(-12)}</code>: {f.err}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        <div className="flex justify-end gap-2 pt-2">
          <Button variant="outline" size="sm" onClick={onClose} disabled={busy}>
            {progress && !busy ? "Close" : "Cancel"}
          </Button>
          <Button
            size="sm"
            onClick={mode === "single" ? submitSingle : submitBulk}
            disabled={busy || (mode === "bulk" && bulkTokens.trim().length === 0)}
          >
            {busy
              ? mode === "bulk"
                ? `Adding ${progress?.done ?? 0}/${progress?.total ?? 0}…`
                : "Saving…"
              : mode === "bulk"
                ? "Create all"
                : "Create"}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
