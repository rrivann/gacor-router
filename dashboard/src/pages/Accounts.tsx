import { useCallback, useEffect, useState } from "react";
import { Eye, EyeOff, Plus, RefreshCw, Search, Trash2, Copy, Check, ArrowLeft, Flame, Loader2 } from "lucide-react";
import { Card } from "../components/ui/card";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
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
import { formatDateTime, cn } from "../lib/utils";
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
  const [providerFilter, setProviderFilter] = useState("all");
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

  const providers = [...new Set(accounts.map((a) => a.provider))].sort();

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

  async function handleDelete(id: number) {
    if (!confirm(`Delete account #${id}? This cannot be undone.`)) return;
    try {
      await deleteAccount(id);
      ok(`Deleted #${id}`);
      await load();
    } catch (err) {
      fail(err);
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
            <Button variant="outline" size="sm" onClick={load} disabled={loading}>
              <RefreshCw className="h-4 w-4" /> Refresh
            </Button>
            <Button size="sm" onClick={() => { setAddProvider("codebuddy"); setShowAdd(true); }}>
              <Plus className="h-4 w-4" /> Add Account
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
            <Button variant="outline" size="sm" onClick={load} disabled={loading}>
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
        /* Provider summary cards (click drills in, gear toggles rotation) */
        <ProviderCards
          providers={providers}
          accounts={accounts}
          selected={providerFilter}
          rotation={rotation}
          onSelect={selectProvider}
          onAdd={(p) => {
            setAddProvider(p);
            setShowAdd(true);
          }}
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
                    <th className="px-4 py-3">ID</th>
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
                      <td colSpan={8} className="px-4 py-10 text-center text-muted-foreground">
                        {loading ? "Loading…" : `No ${providerFilter} accounts found`}
                      </td>
                    </tr>
                  )}
                  {filtered.map((a) => (
                    <tr key={a.id} className="border-b border-border/60 last:border-0 hover:bg-secondary/40">
                  <td className="px-4 py-2.5 tabular-nums text-muted-foreground">#{a.id}</td>
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
                      <Button variant="ghost" size="icon" onClick={() => handleDelete(a.id)} aria-label="Delete">
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
        onClose={() => setShowAdd(false)}
        onCreated={async () => {
          setShowAdd(false);
          ok("Account created");
          await load();
        }}
        onError={fail}
      />
    </div>
  );
}

function AddAccountDialog({
  open,
  initialProvider,
  onClose,
  onCreated,
  onError,
}: {
  open: boolean;
  initialProvider: string;
  onClose: () => void;
  onCreated: () => void;
  onError: (err: unknown) => void;
}) {
  const [provider, setProvider] = useState(initialProvider);
  const [label, setLabel] = useState("");
  const [mode, setMode] = useState<"secret" | "creds">("creds");
  const [secret, setSecret] = useState("");
  const [accessToken, setAccessToken] = useState("");
  const [refreshToken, setRefreshToken] = useState("");
  const [busy, setBusy] = useState(false);

  // A card's "+ Add account" preselects its provider for the next open.
  useEffect(() => {
    if (open) setProvider(initialProvider);
  }, [open, initialProvider]);

  async function submit() {
    setBusy(true);
    try {
      const creds: Record<string, string> = {};
      if (accessToken.trim()) creds.access_token = accessToken.trim();
      if (refreshToken.trim()) creds.refresh_token = refreshToken.trim();
      await createAccount({
        provider: provider.trim(),
        label: label.trim() || undefined,
        secret: mode === "secret" ? secret.trim() : undefined,
        creds: mode === "creds" && Object.keys(creds).length > 0 ? creds : undefined,
      });
      onCreated();
    } catch (err) {
      onError(err);
    } finally {
      setBusy(false);
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
            <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="my-account" />
          </label>
        </div>

        <div className="flex gap-2">
          <Button
            variant={mode === "creds" ? "default" : "outline"}
            size="sm"
            onClick={() => setMode("creds")}
          >
            Token pair
          </Button>
          <Button
            variant={mode === "secret" ? "default" : "outline"}
            size="sm"
            onClick={() => setMode("secret")}
          >
            Single token
          </Button>
        </div>

        {mode === "creds" ? (
          <div className="space-y-3">
            <label className="block space-y-1 text-sm">
              <span className="text-xs text-muted-foreground">access_token</span>
              <Input value={accessToken} onChange={(e) => setAccessToken(e.target.value)} />
            </label>
            <label className="block space-y-1 text-sm">
              <span className="text-xs text-muted-foreground">refresh_token (optional, enables auto-refresh)</span>
              <Input value={refreshToken} onChange={(e) => setRefreshToken(e.target.value)} />
            </label>
          </div>
        ) : (
          <label className="block space-y-1 text-sm">
            <span className="text-xs text-muted-foreground">secret / api key</span>
            <Input value={secret} onChange={(e) => setSecret(e.target.value)} />
          </label>
        )}

        <div className="flex justify-end gap-2 pt-2">
          <Button variant="outline" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" onClick={submit} disabled={busy}>
            {busy ? "Saving…" : "Create"}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
