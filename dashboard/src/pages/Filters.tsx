import { useEffect, useState } from "react";
import { ArrowRight, Loader2, Plus, RefreshCw, Trash2 } from "lucide-react";
import { Card } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { Button } from "../components/ui/button";
import {
  createFilter,
  deleteFilter,
  fetchFilters,
  fetchModels,
  updateFilter,
  type ContentFilter,
} from "../lib/api";
import { cn } from "../lib/utils";
import { useTimedMessage } from "../hooks/useTimedMessage";

// Filters page — pattern → replacement rules applied to outbound message text
// before it reaches the provider. enowx-inspired: dense list, toggle + delete
// per row, add form on top.

export default function Filters() {
  const [rows, setRows] = useState<ContentFilter[] | null>(null);
  const [providers, setProviders] = useState<string[]>([]);
  const [pattern, setPattern] = useState("");
  const [replacement, setReplacement] = useState("");
  const [isRegex, setIsRegex] = useState(false);
  const [scopeSel, setScopeSel] = useState<Set<string>>(new Set());
  const [editingScope, setEditingScope] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { message, setMessage, clearMessage } = useTimedMessage<string | null>(null);

  async function load() {
    try {
      const r = await fetchFilters();
      setRows(r.data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  useEffect(() => {
    load();
    // Enumerate providers from /v1/models — same list the Models page uses.
    fetchModels()
      .then((r) => {
        const set = new Set<string>();
        for (const m of r.data) {
          const p = m.id.split("/")[0];
          if (p) set.add(p);
        }
        setProviders([...set].sort());
      })
      .catch(() => setProviders([]));
  }, []);

  function ok(text: string) {
    setMessage(text);
    setError(null);
  }
  function fail(err: unknown) {
    setError(err instanceof Error ? err.message : String(err));
    clearMessage();
  }

  async function handleAdd() {
    const p = pattern.trim();
    if (!p) return;
    setBusy(true);
    try {
      const providerScope = scopeSel.size === 0 ? null : [...scopeSel];
      await createFilter({ pattern: p, replacement, isRegex, isActive: true, providerScope });
      setPattern("");
      setReplacement("");
      setIsRegex(false);
      setScopeSel(new Set());
      ok("Filter added");
      await load();
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  }

  function toggleScope(p: string) {
    setScopeSel((prev) => {
      const next = new Set(prev);
      if (next.has(p)) next.delete(p);
      else next.add(p);
      return next;
    });
  }

  async function handleToggle(f: ContentFilter) {
    try {
      await updateFilter(f.id, { isActive: !f.isActive });
      await load();
    } catch (err) {
      fail(err);
    }
  }

  async function handleScopeChange(f: ContentFilter, provider: string) {
    const current = new Set(f.providerScope ?? []);
    if (current.has(provider)) current.delete(provider);
    else current.add(provider);
    try {
      await updateFilter(f.id, { providerScope: [...current] }); // backend normalizes [] → null
      await load();
    } catch (err) {
      fail(err);
    }
  }

  async function handleScopeClear(f: ContentFilter) {
    try {
      await updateFilter(f.id, { providerScope: null });
      await load();
    } catch (err) {
      fail(err);
    }
  }

  async function handleDelete(id: number) {
    try {
      await deleteFilter(id);
      ok(`Filter #${id} deleted`);
      await load();
    } catch (err) {
      fail(err);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold">Filters</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Rewrite outbound message text before it reaches the provider
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={load}>
          <RefreshCw className="h-4 w-4" /> Refresh
        </Button>
      </div>

      {error && (
        <div className="rounded-md border border-error/30 bg-error/10 px-3 py-2 text-sm text-error">{error}</div>
      )}
      {message && !error && (
        <div className="rounded-md border border-success/30 bg-success/10 px-3 py-2 text-sm text-success">{message}</div>
      )}

      <Card className="p-4">
        <div className="mb-3 text-sm font-medium">Add rule</div>
        <div className="grid gap-2 sm:grid-cols-[1fr_1fr_auto_auto]">
          <label className="space-y-1">
            <span className="text-xs text-muted-foreground">Pattern</span>
            <Input
              value={pattern}
              onChange={(e) => setPattern(e.target.value)}
              placeholder="word or regex"
              onKeyDown={(e) => e.key === "Enter" && handleAdd()}
            />
          </label>
          <label className="space-y-1">
            <span className="text-xs text-muted-foreground">Replacement (empty = remove)</span>
            <Input
              value={replacement}
              onChange={(e) => setReplacement(e.target.value)}
              placeholder=""
              onKeyDown={(e) => e.key === "Enter" && handleAdd()}
            />
          </label>
          <label className="flex items-end gap-1.5 pb-2 text-xs text-secondary-foreground">
            <input
              type="checkbox"
              checked={isRegex}
              onChange={(e) => setIsRegex(e.target.checked)}
              className="h-3.5 w-3.5"
            />
            Regex
          </label>
          <div className="flex items-end">
            <Button size="sm" onClick={handleAdd} disabled={busy || pattern.trim().length === 0}>
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />} Add
            </Button>
          </div>
        </div>
        {providers.length > 0 && (
          <div className="mt-3">
            <div className="mb-1.5 text-xs text-muted-foreground">
              Provider scope <span className="text-muted-foreground/70">(none selected = apply to all)</span>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {providers.map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => toggleScope(p)}
                  className={cn(
                    "rounded-md border px-2 py-0.5 text-xs capitalize transition-colors",
                    scopeSel.has(p)
                      ? "border-primary/50 bg-primary/15 text-primary"
                      : "border-border text-secondary-foreground hover:bg-secondary"
                  )}
                >
                  {p}
                </button>
              ))}
            </div>
          </div>
        )}
        <p className="mt-2 text-xs text-muted-foreground">
          Rules apply to text in every outbound message, before compression and before the request
          is built. Non-regex patterns are matched literally, case-sensitive.
        </p>
      </Card>

      <Card>
        {!rows ? (
          <div className="flex justify-center py-10 text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
          </div>
        ) : rows.length === 0 ? (
          <div className="py-10 text-center text-sm text-muted-foreground">
            No filters yet. Add one above.
          </div>
        ) : (
          <div className="divide-y divide-border/60">
            {rows.map((f) => (
              <div
                key={f.id}
                className={cn(
                  "flex items-center gap-2 px-4 py-2.5 text-sm",
                  !f.isActive && "opacity-50"
                )}
              >
                <span className="w-8 shrink-0 tabular-nums text-muted-foreground">#{f.id}</span>
                <code className="min-w-0 flex-1 truncate font-mono text-xs">{f.pattern}</code>
                <ArrowRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <code className="min-w-0 flex-1 truncate font-mono text-xs text-success">
                  {f.replacement || <span className="text-muted-foreground italic">(removed)</span>}
                </code>
                {f.isRegex && (
                  <span className="shrink-0 rounded bg-secondary px-1.5 py-0.5 text-[10px] uppercase text-muted-foreground">
                    regex
                  </span>
                )}
                <div className="relative shrink-0">
                  <button
                    type="button"
                    onClick={() => setEditingScope(editingScope === f.id ? null : f.id)}
                    className={cn(
                      "rounded px-1.5 py-0.5 text-[10px] transition-colors",
                      f.providerScope === null
                        ? "bg-secondary text-muted-foreground hover:bg-secondary/80"
                        : "bg-info/15 text-info hover:bg-info/25"
                    )}
                    title="Click to edit provider scope"
                  >
                    {f.providerScope === null ? "all" : f.providerScope.join(",")}
                  </button>
                  {editingScope === f.id && (
                    <>
                      <div className="fixed inset-0 z-10" onClick={() => setEditingScope(null)} />
                      <div className="absolute right-0 top-full z-20 mt-1 min-w-40 rounded-md border border-border bg-card p-2 shadow-lg">
                        <div className="mb-1.5 flex items-center justify-between gap-2 text-[10px] text-muted-foreground">
                          <span>Provider scope</span>
                          <button
                            onClick={() => { handleScopeClear(f); setEditingScope(null); }}
                            className="rounded px-1 hover:bg-secondary hover:text-foreground"
                            title="Apply to all providers"
                          >
                            clear
                          </button>
                        </div>
                        {providers.length === 0 ? (
                          <div className="text-[10px] text-muted-foreground">No providers loaded</div>
                        ) : (
                          <div className="space-y-0.5">
                            {providers.map((p) => {
                              const checked = (f.providerScope ?? []).includes(p);
                              return (
                                <label
                                  key={p}
                                  className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-xs hover:bg-secondary"
                                >
                                  <input
                                    type="checkbox"
                                    checked={checked}
                                    onChange={() => handleScopeChange(f, p)}
                                    className="h-3 w-3"
                                  />
                                  <span className="capitalize">{p}</span>
                                </label>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    </>
                  )}
                </div>
                <div className="ml-2 flex shrink-0 items-center gap-1.5">
                  <button
                    onClick={() => handleToggle(f)}
                    title={f.isActive ? "Disable" : "Enable"}
                    className={cn(
                      "relative h-4 w-7 rounded-full transition-colors",
                      f.isActive ? "bg-success/80" : "bg-secondary"
                    )}
                  >
                    <span
                      className={cn(
                        "absolute top-0.5 left-0.5 h-3 w-3 rounded-full bg-white transition-transform",
                        f.isActive && "translate-x-3"
                      )}
                    />
                  </button>
                  <button
                    onClick={() => handleDelete(f.id)}
                    title="Delete"
                    className="rounded p-1 text-muted-foreground hover:bg-secondary hover:text-error"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
