import { useEffect, useMemo, useState } from "react";
import {
  Check,
  Copy,
  Eye,
  EyeOff,
  KeyRound,
  Loader2,
  Plus,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { Card } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Dialog } from "../components/ui/dialog";
import {
  createApiKey,
  deleteApiKey,
  fetchApiKeys,
  fetchModels,
  updateApiKey,
  type ApiKey,
} from "../lib/api";
import { cn, formatDateTime, formatTokens } from "../lib/utils";
import { useTimedMessage } from "../hooks/useTimedMessage";

// API Keys page. Multi-key model (enowx pattern) with etteum's always-reveal
// UX (Eye toggle + copy). Local-first: keys are stored plaintext, dashboard
// is trusted, no one-time-show ceremony.

export default function ApiKeys() {
  const [rows, setRows] = useState<ApiKey[] | null>(null);
  const [providers, setProviders] = useState<string[]>([]);
  const [modelIds, setModelIds] = useState<string[]>([]);
  const [addOpen, setAddOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<ApiKey | null>(null);
  const [revealed, setRevealed] = useState<Set<number>>(new Set());
  const [copied, setCopied] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { message, setMessage, clearMessage } = useTimedMessage<string | null>(null);

  async function load() {
    try {
      const r = await fetchApiKeys();
      setRows(r.data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  useEffect(() => {
    load();
    fetchModels()
      .then((r) => {
        const provSet = new Set<string>();
        const modSet = new Set<string>();
        for (const m of r.data) {
          const [p, ...rest] = m.id.split("/");
          if (p) provSet.add(p);
          if (rest.length > 0) modSet.add(rest.join("/"));
        }
        setProviders([...provSet].sort());
        setModelIds([...modSet].sort());
      })
      .catch(() => {
        setProviders([]);
        setModelIds([]);
      });
  }, []);

  function ok(text: string) {
    setMessage(text);
    setError(null);
  }
  function fail(err: unknown) {
    setError(err instanceof Error ? err.message : String(err));
    clearMessage();
  }

  function toggleReveal(id: number) {
    setRevealed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function copySecret(k: ApiKey) {
    try {
      await navigator.clipboard.writeText(k.secret);
      setCopied(k.id);
      setTimeout(() => setCopied((cur) => (cur === k.id ? null : cur)), 1200);
    } catch {
      fail("clipboard blocked — reveal and copy manually");
    }
  }

  async function handleToggleEnabled(k: ApiKey) {
    try {
      await updateApiKey(k.id, { enabled: !k.enabled });
      await load();
    } catch (err) {
      fail(err);
    }
  }

  async function handleDelete() {
    if (!deleteTarget) return;
    try {
      await deleteApiKey(deleteTarget.id);
      ok(`Key #${deleteTarget.id} deleted`);
      setDeleteTarget(null);
      setRevealed((prev) => {
        const next = new Set(prev);
        next.delete(deleteTarget.id);
        return next;
      });
      await load();
    } catch (err) {
      fail(err);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold">API Keys</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Tokens clients send in <code className="rounded bg-secondary px-1 py-0.5 text-xs">Authorization: Bearer …</code> to
            /v1/*. Loopback + fresh installs auto-bypass.
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={load}>
            <RefreshCw className="h-4 w-4" /> Refresh
          </Button>
          <Button size="sm" onClick={() => setAddOpen(true)}>
            <Plus className="h-4 w-4" /> New key
          </Button>
        </div>
      </div>

      {error && (
        <div className="rounded-md border border-error/30 bg-error/10 px-3 py-2 text-sm text-error">{error}</div>
      )}
      {message && !error && (
        <div className="rounded-md border border-success/30 bg-success/10 px-3 py-2 text-sm text-success">
          {message}
        </div>
      )}

      <Card>
        {!rows ? (
          <div className="flex justify-center py-10 text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
          </div>
        ) : rows.length === 0 ? (
          <div className="space-y-2 py-12 text-center">
            <KeyRound className="mx-auto h-8 w-8 text-muted-foreground" />
            <div className="text-sm font-medium">No keys yet</div>
            <p className="mx-auto max-w-md text-xs text-muted-foreground">
              /v1/* is open right now (open-gateway). Create a key to close the door — once one
              exists, clients must present it (loopback still bypasses).
            </p>
            <Button size="sm" onClick={() => setAddOpen(true)}>
              <Plus className="h-4 w-4" /> Create first key
            </Button>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="px-4 py-3">Label</th>
                  <th className="px-4 py-3">Key</th>
                  <th className="px-4 py-3 text-right">Usage</th>
                  <th className="px-4 py-3">Scope</th>
                  <th className="px-4 py-3">Last used</th>
                  <th className="px-4 py-3">Expires</th>
                  <th className="px-4 py-3"></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((k) => {
                  const isRevealed = revealed.has(k.id);
                  const isCopied = copied === k.id;
                  const expired = k.expiresAt && new Date(k.expiresAt).getTime() < Date.now();
                  const quotaHit = k.tokenLimit > 0 && k.tokensUsed >= k.tokenLimit;
                  return (
                    <tr
                      key={k.id}
                      className={cn(
                        "border-b border-border/60 last:border-0 hover:bg-secondary/40",
                        (!k.enabled || expired || quotaHit) && "opacity-60"
                      )}
                    >
                      <td className="px-4 py-2.5 font-medium">
                        {k.label || <span className="text-muted-foreground italic">no label</span>}
                        {!k.enabled && (
                          <span className="ml-1.5 rounded bg-secondary px-1.5 py-0.5 text-[10px] uppercase text-muted-foreground">
                            off
                          </span>
                        )}
                        {expired && (
                          <span className="ml-1.5 rounded bg-error/15 px-1.5 py-0.5 text-[10px] uppercase text-error">
                            expired
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-2.5">
                        <div className="flex items-center gap-1.5">
                          <code className="max-w-[280px] truncate font-mono text-xs text-secondary-foreground">
                            {isRevealed ? k.secret : maskKey(k.secret)}
                          </code>
                          <button
                            onClick={() => toggleReveal(k.id)}
                            className="rounded p-1 text-muted-foreground hover:bg-secondary hover:text-foreground"
                            title={isRevealed ? "Hide" : "Reveal"}
                          >
                            {isRevealed ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                          </button>
                          <button
                            onClick={() => copySecret(k)}
                            className="rounded p-1 text-muted-foreground hover:bg-secondary hover:text-foreground"
                            title="Copy"
                          >
                            {isCopied ? (
                              <Check className="h-3.5 w-3.5 text-success" />
                            ) : (
                              <Copy className="h-3.5 w-3.5" />
                            )}
                          </button>
                        </div>
                      </td>
                      <td className="px-4 py-2.5 text-right tabular-nums text-xs">
                        {k.tokenLimit > 0 ? (
                          <span className={quotaHit ? "text-error" : "text-secondary-foreground"}>
                            {formatTokens(k.tokensUsed)} / {formatTokens(k.tokenLimit)}
                          </span>
                        ) : (
                          <span className="text-muted-foreground">
                            {formatTokens(k.tokensUsed)} <span className="text-muted-foreground/60">/ ∞</span>
                          </span>
                        )}
                        {k.maxConcurrent > 0 && (
                          <div className="text-[10px] text-muted-foreground">≤ {k.maxConcurrent} live</div>
                        )}
                      </td>
                      <td className="px-4 py-2.5 text-xs">
                        <ScopeBadge label="prov" values={k.allowedProviders} />
                        <ScopeBadge label="mdl" values={k.allowedModels} />
                      </td>
                      <td className="px-4 py-2.5 text-xs text-muted-foreground">
                        {k.lastUsedAt ? formatDateTime(k.lastUsedAt) : "—"}
                      </td>
                      <td className="px-4 py-2.5 text-xs text-muted-foreground">
                        {k.expiresAt ? formatDateTime(k.expiresAt) : <span className="text-muted-foreground/60">never</span>}
                      </td>
                      <td className="px-4 py-2.5">
                        <div className="flex items-center justify-end gap-1.5">
                          <button
                            onClick={() => handleToggleEnabled(k)}
                            title={k.enabled ? "Disable" : "Enable"}
                            className={cn(
                              "relative h-4 w-7 rounded-full transition-colors",
                              k.enabled ? "bg-success/80" : "bg-secondary"
                            )}
                          >
                            <span
                              className={cn(
                                "absolute top-0.5 left-0.5 h-3 w-3 rounded-full bg-white transition-transform",
                                k.enabled && "translate-x-3"
                              )}
                            />
                          </button>
                          <button
                            onClick={() => setDeleteTarget(k)}
                            title="Delete"
                            className="rounded p-1 text-muted-foreground hover:bg-secondary hover:text-error"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <AddKeyDialog
        open={addOpen}
        onClose={() => setAddOpen(false)}
        providers={providers}
        modelIds={modelIds}
        onCreated={async (secret) => {
          setAddOpen(false);
          try {
            await navigator.clipboard.writeText(secret);
            ok("Key created & copied to clipboard");
          } catch {
            ok("Key created (clipboard blocked — reveal to copy)");
          }
          await load();
        }}
        onFail={fail}
      />

      <Dialog
        open={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        title="Delete API key"
      >
        <div className="space-y-3">
          <p className="text-sm text-secondary-foreground">
            Delete key <span className="font-medium">{deleteTarget?.label || `#${deleteTarget?.id}`}</span>? Any client
            still using it will start getting 401s.
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="outline" size="sm" onClick={() => setDeleteTarget(null)}>
              Cancel
            </Button>
            <Button variant="destructive" size="sm" onClick={handleDelete}>
              Delete
            </Button>
          </div>
        </div>
      </Dialog>
    </div>
  );
}

function maskKey(secret: string): string {
  if (secret.length <= 12) return "•".repeat(secret.length);
  return secret.slice(0, 6) + "…" + secret.slice(-4);
}

function ScopeBadge({ label, values }: { label: string; values: string[] | null }) {
  if (!values || values.length === 0) {
    return (
      <span className="mr-1 rounded bg-secondary px-1.5 py-0.5 text-[10px] text-muted-foreground">
        {label}: all
      </span>
    );
  }
  return (
    <span
      className="mr-1 rounded bg-info/15 px-1.5 py-0.5 text-[10px] text-info"
      title={values.join(", ")}
    >
      {label}: {values.length === 1 ? values[0] : `${values.length} pinned`}
    </span>
  );
}

function AddKeyDialog({
  open,
  onClose,
  providers,
  modelIds,
  onCreated,
  onFail,
}: {
  open: boolean;
  onClose: () => void;
  providers: string[];
  modelIds: string[];
  onCreated: (secret: string) => void;
  onFail: (err: unknown) => void;
}) {
  const [label, setLabel] = useState("");
  const [tokenLimit, setTokenLimit] = useState("");
  const [maxConcurrent, setMaxConcurrent] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [scopedProviders, setScopedProviders] = useState<Set<string>>(new Set());
  const [scopedModels, setScopedModels] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  // Reset all fields when the dialog opens — a previous entry that lingered
  // once bit us in the accounts add flow.
  useEffect(() => {
    if (!open) return;
    setLabel("");
    setTokenLimit("");
    setMaxConcurrent("");
    setExpiresAt("");
    setScopedProviders(new Set());
    setScopedModels(new Set());
    setBusy(false);
  }, [open]);

  function togglePick(set: Set<string>, value: string, setter: (s: Set<string>) => void) {
    const next = new Set(set);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    setter(next);
  }

  const visibleModels = useMemo(() => {
    if (scopedProviders.size === 0) return modelIds;
    // If providers are scoped, only offer models available under those providers.
    // The models list here is bare ids (no prefix), so keep the intersection
    // hint by simply showing all — refining would require the full route map.
    return modelIds;
  }, [scopedProviders, modelIds]);

  async function submit() {
    setBusy(true);
    try {
      const parsedLimit = tokenLimit ? Number(tokenLimit) : 0;
      const parsedConc = maxConcurrent ? Number(maxConcurrent) : 0;
      let expIso: string | null = null;
      if (expiresAt) {
        const d = new Date(expiresAt);
        if (Number.isNaN(d.getTime())) {
          onFail("expires_at must be a valid datetime");
          setBusy(false);
          return;
        }
        expIso = d.toISOString();
      }
      const r = await createApiKey({
        label: label.trim(),
        tokenLimit: Number.isFinite(parsedLimit) && parsedLimit >= 0 ? parsedLimit : 0,
        maxConcurrent: Number.isFinite(parsedConc) && parsedConc >= 0 ? parsedConc : 0,
        expiresAt: expIso,
        allowedProviders: scopedProviders.size === 0 ? null : [...scopedProviders],
        allowedModels: scopedModels.size === 0 ? null : [...scopedModels],
      });
      onCreated(r.secret);
    } catch (err) {
      onFail(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onClose={onClose} title="New API key">
      <div className="space-y-3">
        <label className="block space-y-1">
          <span className="text-xs text-muted-foreground">Label</span>
          <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. CL4ude Code laptop" />
        </label>

        <div className="grid gap-3 sm:grid-cols-3">
          <label className="block space-y-1">
            <span className="text-xs text-muted-foreground">Token limit (0 = ∞)</span>
            <Input
              inputMode="numeric"
              value={tokenLimit}
              onChange={(e) => setTokenLimit(e.target.value.replace(/[^\d]/g, ""))}
              placeholder="0"
            />
          </label>
          <label className="block space-y-1">
            <span className="text-xs text-muted-foreground">Max concurrent (0 = ∞)</span>
            <Input
              inputMode="numeric"
              value={maxConcurrent}
              onChange={(e) => setMaxConcurrent(e.target.value.replace(/[^\d]/g, ""))}
              placeholder="0"
            />
          </label>
          <label className="block space-y-1">
            <span className="text-xs text-muted-foreground">Expires at</span>
            <Input
              type="datetime-local"
              value={expiresAt}
              onChange={(e) => setExpiresAt(e.target.value)}
            />
          </label>
        </div>

        <div className="space-y-1">
          <div className="text-xs text-muted-foreground">
            Provider scope <span className="text-muted-foreground/70">(none = all)</span>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {providers.length === 0 ? (
              <span className="text-xs text-muted-foreground">no providers</span>
            ) : (
              providers.map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => togglePick(scopedProviders, p, setScopedProviders)}
                  className={cn(
                    "rounded-md border px-2 py-0.5 text-xs capitalize transition-colors",
                    scopedProviders.has(p)
                      ? "border-primary/50 bg-primary/15 text-primary"
                      : "border-border text-secondary-foreground hover:bg-secondary"
                  )}
                >
                  {p}
                </button>
              ))
            )}
          </div>
        </div>

        <div className="space-y-1">
          <div className="text-xs text-muted-foreground">
            Model scope <span className="text-muted-foreground/70">(none = all)</span>
          </div>
          <div className="flex max-h-32 flex-wrap gap-1.5 overflow-y-auto rounded border border-border bg-background p-1.5">
            {visibleModels.length === 0 ? (
              <span className="text-xs text-muted-foreground">no models</span>
            ) : (
              visibleModels.map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => togglePick(scopedModels, m, setScopedModels)}
                  className={cn(
                    "rounded border px-1.5 py-0.5 text-[11px] transition-colors",
                    scopedModels.has(m)
                      ? "border-primary/50 bg-primary/15 text-primary"
                      : "border-border/60 text-secondary-foreground hover:bg-secondary"
                  )}
                >
                  {m}
                </button>
              ))
            )}
          </div>
        </div>

        <div className="flex justify-end gap-2 pt-1">
          <Button variant="outline" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" onClick={submit} disabled={busy}>
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <KeyRound className="h-3.5 w-3.5" />}
            Create
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
