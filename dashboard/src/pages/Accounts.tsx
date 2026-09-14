import { useCallback, useEffect, useState } from "react";
import { Eye, EyeOff, Plus, RefreshCw, Search, Trash2, Copy, Check } from "lucide-react";
import { Card, CardContent } from "../components/ui/card";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Input, Select } from "../components/ui/input";
import { Dialog } from "../components/ui/dialog";
import { Toggle } from "../components/ui/toggle";
import {
  createAccount,
  deleteAccount,
  fetchAccounts,
  fetchSettings,
  revealAccount,
  saveSettings,
  setAccountStatus,
  refreshUsage,
  type AccountRow,
} from "../lib/api";
import { formatDateTime } from "../lib/utils";
import { useTimedMessage } from "../hooks/useTimedMessage";
import { useWsEvent } from "../hooks/useWebSocket";
import { CreditCell } from "../components/accounts/CreditCell";

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
  const [rotation, setRotation] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const { message, setMessage, clearMessage } = useTimedMessage<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);
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
  const filtered = accounts.filter((a) => {
    if (providerFilter !== "all" && a.provider !== providerFilter) return false;
    const q = search.toLowerCase();
    return (
      !q ||
      a.provider.toLowerCase().includes(q) ||
      (a.label ?? "").toLowerCase().includes(q) ||
      String(a.id).includes(q)
    );
  });

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

  return (
    <div className="space-y-6">
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
          <Button size="sm" onClick={() => setShowAdd(true)}>
            <Plus className="h-4 w-4" /> Add Account
          </Button>
        </div>
      </div>

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

      <div className="flex flex-col gap-3 sm:flex-row">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search accounts…"
            className="pl-9"
          />
        </div>
        <Select value={providerFilter} onChange={(e) => setProviderFilter(e.target.value)} className="sm:w-48">
          <option value="all">All providers</option>
          {providers.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </Select>
      </div>

      {/* Per-provider rotation controls */}
      {providers.length > 0 && (
        <Card>
          <CardContent className="flex flex-wrap items-center gap-x-6 gap-y-2 p-3">
            <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Rotation
            </span>
            {providers.map((p) => (
              <label key={p} className="flex items-center gap-2 text-sm">
                <span className="text-secondary-foreground">{p}</span>
                <Toggle
                  checked={rotation[p] === "round-robin"}
                  onChange={(next) => handleRotation(p, next)}
                  label={`${p} round-robin`}
                />
                <span className="text-xs text-muted-foreground">
                  {rotation[p] === "round-robin" ? "round-robin" : "sticky"}
                </span>
              </label>
            ))}
          </CardContent>
        </Card>
      )}

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
                    {loading ? "Loading…" : "No accounts found"}
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

      <AddAccountDialog
        open={showAdd}
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
  onClose,
  onCreated,
  onError,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
  onError: (err: unknown) => void;
}) {
  const [provider, setProvider] = useState("codebuddy");
  const [label, setLabel] = useState("");
  const [mode, setMode] = useState<"secret" | "creds">("creds");
  const [secret, setSecret] = useState("");
  const [accessToken, setAccessToken] = useState("");
  const [refreshToken, setRefreshToken] = useState("");
  const [busy, setBusy] = useState(false);

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
