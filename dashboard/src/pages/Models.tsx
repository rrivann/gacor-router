import { useEffect, useMemo, useState } from "react";
import { Check, Copy, RefreshCw, Search } from "lucide-react";
import { Card } from "../components/ui/card";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { fetchModels, type ModelInfo } from "../lib/api";
import { cn, formatTokens } from "../lib/utils";

// Owner badge palette — keyed by the owned_by string so every vendor reads
// distinctly (etteum pattern).
const OWNER_VARIANT: Record<string, "default" | "info" | "success" | "warning" | "secondary"> = {
  anthropic: "warning",
  openai: "success",
  google: "info",
  deepseek: "default",
  zhipu: "secondary",
  moonshot: "secondary",
  minimax: "secondary",
};

export default function Models() {
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [provider, setProvider] = useState("all");
  const [kind, setKind] = useState<"all" | "chat" | "image" | "video">("all");
  const [copied, setCopied] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    try {
      const res = await fetchModels();
      setModels(res.data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  const providers = useMemo(
    () => [...new Set(models.map((m) => m.id.split("/")[0]!))].sort(),
    [models]
  );

  const kindCounts = useMemo(() => {
    const c = { all: models.length, chat: 0, image: 0, video: 0 };
    for (const m of models) c[m.kind]++;
    return c;
  }, [models]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const rows = models.filter((m) => {
      if (provider !== "all" && m.id.split("/")[0] !== provider) return false;
      if (kind !== "all" && m.kind !== kind) return false;
      if (!q) return true;
      const name = m.id.split("/").slice(1).join("/");
      return (
        name.toLowerCase().includes(q) ||
        m.id.toLowerCase().includes(q) ||
        m.owned_by.toLowerCase().includes(q)
      );
    });
    // Group by owner (no-owner last), then by model id within a group —
    // the table reads as neat vendor sections.
    const ownerRank = (o: string) => (o ? 0 : 1);
    return rows.sort((a, b) => {
      const ra = ownerRank(a.owned_by);
      const rb = ownerRank(b.owned_by);
      if (ra !== rb) return ra - rb;
      if (a.owned_by !== b.owned_by) return a.owned_by.localeCompare(b.owned_by);
      return a.id.localeCompare(b.id);
    });
  }, [models, search, provider, kind]);

  async function copyId(id: string) {
    await navigator.clipboard.writeText(id);
    setCopied(id);
    setTimeout(() => setCopied(null), 1500);
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold">Models</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {models.length} models available across {providers.length}{" "}
            {providers.length === 1 ? "provider" : "providers"}
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={load} disabled={loading}>
          <RefreshCw className="h-4 w-4" /> Refresh
        </Button>
      </div>

      {error && (
        <div className="rounded-md border border-error/30 bg-error/10 px-3 py-2 text-sm text-error">{error}</div>
      )}

      {/* Free-promo models (0x credits) — from the official catalogue */}
      <div className="rounded-lg border border-success/30 bg-success/5 px-4 py-3">
        <p className="text-xs font-semibold text-success">🆓 3 models free right now (0x credits)</p>
        <div className="mt-1.5 flex flex-wrap gap-x-5 gap-y-1 text-xs text-secondary-foreground">
          <span><code className="text-success">hy3</code> · free unlimited until 30 Sep 2026</span>
          <span><code className="text-success">hy4-preview-f</code> · free until 10 Oct 2026</span>
          <span><code className="text-success">deepseek-v4.1-flash</code> · free until 25 Sep 2026 (1M ctx, multimodal)</span>
        </div>
      </div>

      <div className="relative">
        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search models, owners…"
          className="pl-9"
        />
      </div>

      {/* Provider + kind filter pills */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex flex-wrap items-center gap-1.5">
          {["all", ...providers].map((p) => (
            <button
              key={p}
              onClick={() => setProvider(p)}
              className={cn(
                "rounded-md border px-2.5 py-1 text-xs capitalize transition-colors",
                provider === p
                  ? "border-primary/50 bg-primary/15 text-primary"
                  : "border-border text-secondary-foreground hover:bg-secondary hover:text-foreground"
              )}
            >
              {p === "all" ? "All" : p}
            </button>
          ))}
        </div>
        <span className="text-xs text-muted-foreground">·</span>
        <div className="flex flex-wrap items-center gap-1.5">
          {(["all", "chat", "image", "video"] as const).map((k) => (
            <button
              key={k}
              onClick={() => setKind(k)}
              className={cn(
                "rounded-md border px-2.5 py-1 text-xs capitalize transition-colors",
                kind === k
                  ? "border-primary/50 bg-primary/15 text-primary"
                  : "border-border text-secondary-foreground hover:bg-secondary hover:text-foreground"
              )}
            >
              {k === "all" ? "All kinds" : k} ({kindCounts[k]})
            </button>
          ))}
        </div>
      </div>

      <Card>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                <th className="px-4 py-3">Model</th>
                <th className="px-4 py-3">Owner</th>
                <th className="px-4 py-3 text-right">Context</th>
                <th className="px-4 py-3 text-right">Output</th>
                <th className="px-4 py-3 text-right">Credits</th>
                <th className="px-4 py-3">Features</th>
                <th className="px-4 py-3 text-right">
                  <span className="sr-only">Copy</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-4 py-10 text-center text-muted-foreground">
                    {loading ? "Loading…" : "No models match"}
                  </td>
                </tr>
              )}
              {filtered.map((m) => {
                const name = m.id.split("/").slice(1).join("/");
                return (
                  <tr key={m.id} className="border-b border-border/60 last:border-0 hover:bg-secondary/40">
                    <td className="px-4 py-2.5">
                      <div className="flex flex-col">
                        <code className="text-sm">{name}</code>
                        {m.name !== name && m.name !== m.id.split("/").slice(1).join("/") && (
                          <span className="text-[10px] text-muted-foreground">{m.name}</span>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-2.5">
                      {m.owned_by ? (
                        <Badge variant={OWNER_VARIANT[m.owned_by] ?? "secondary"} className="normal-case">
                          {m.owned_by}
                        </Badge>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-secondary-foreground">
                      {m.max_input_tokens ? formatTokens(m.max_input_tokens) : "—"}
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-secondary-foreground">
                      {m.max_output_tokens ? formatTokens(m.max_output_tokens) : "—"}
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums">
                      {m.credit_multiplier == null ? (
                        <span className="text-xs text-muted-foreground">—</span>
                      ) : m.credit_multiplier === 0 ? (
                        <span className="text-success" title="Free — no credits consumed">🆓 0x</span>
                      ) : (
                        <span className="text-secondary-foreground">x{m.credit_multiplier}</span>
                      )}
                    </td>
                    <td className="px-4 py-2.5">
                      <div className="flex flex-wrap items-center gap-1">
                        {m.kind === "image" && (
                          <Badge variant="info" className="normal-case" title="Image generation model">
                            Image
                          </Badge>
                        )}
                        {m.thinking ? (
                          <Badge
                            variant="success"
                            className="normal-case"
                            title={
                              m.thinking_toggle === "canDisable"
                                ? "Reasoning-capable · thinking can be disabled"
                                : "Reasoning-capable · thinking always on"
                            }
                          >
                            Thinking
                          </Badge>
                        ) : m.thinking_toggle === "canDisable" ? (
                          <Badge variant="info" className="normal-case" title="Thinking can be enabled">
                            Thinking optional
                          </Badge>
                        ) : null}
                        {m.images && (
                          <Badge variant="secondary" className="normal-case" title="Image input supported">
                            Img
                          </Badge>
                        )}
                        {m.tool_calls && (
                          <Badge variant="secondary" className="normal-case" title="Tool calling supported">
                            Tools
                          </Badge>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      <button
                        onClick={() => copyId(m.id)}
                        title={`Copy ${m.id}`}
                        className="rounded-md p-1.5 text-muted-foreground hover:bg-secondary hover:text-foreground"
                      >
                        {copied === m.id ? (
                          <Check className="h-3.5 w-3.5 text-success" />
                        ) : (
                          <Copy className="h-3.5 w-3.5" />
                        )}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>

      <p className="text-xs text-muted-foreground">
        Address a model as{" "}
        <code className="rounded bg-secondary px-1 py-0.5">provider/model</code> in your client —
        e.g. <code className="rounded bg-secondary px-1 py-0.5">{filtered[0]?.id ?? "codebuddy/claude-opus-5"}</code>
      </p>
    </div>
  );
}
