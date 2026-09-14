import { useEffect, useState } from "react";
import { RefreshCw, Search } from "lucide-react";
import { Card } from "../components/ui/card";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { fetchModels, type ModelInfo } from "../lib/api";

export default function Models() {
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");

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

  const filtered = models.filter((m) => m.id.toLowerCase().includes(search.toLowerCase()));
  const byProvider = new Map<string, ModelInfo[]>();
  for (const m of filtered) {
    const provider = m.id.split("/")[0] ?? "unknown";
    byProvider.set(provider, [...(byProvider.get(provider) ?? []), m]);
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold">Models</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Catalogue exposed at /v1/models — address as{" "}
            <code className="rounded bg-secondary px-1 py-0.5 text-xs">provider/model</code>
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={load} disabled={loading}>
          <RefreshCw className="h-4 w-4" /> Refresh
        </Button>
      </div>

      {error && (
        <div className="rounded-md border border-error/30 bg-error/10 px-3 py-2 text-sm text-error">{error}</div>
      )}

      <div className="relative">
        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search models…" className="pl-9" />
      </div>

      {[...byProvider.entries()].map(([provider, list]) => (
        <div key={provider}>
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            {provider} <span className="font-normal">({list.length})</span>
          </h2>
          <Card>
            <div className="grid grid-cols-1 gap-px overflow-hidden rounded-lg bg-border/60 md:grid-cols-2 lg:grid-cols-3">
              {list.map((m) => (
                <button
                  key={m.id}
                  onClick={() => navigator.clipboard.writeText(m.id)}
                  title="Click to copy"
                  className="flex items-center justify-between gap-2 bg-card px-4 py-2.5 text-left transition-colors hover:bg-secondary/50"
                >
                  <code className="truncate text-sm">{m.id.split("/").slice(1).join("/")}</code>
                  {m.owned_by && <Badge variant="secondary">{m.owned_by}</Badge>}
                </button>
              ))}
            </div>
          </Card>
        </div>
      ))}

      {!loading && filtered.length === 0 && (
        <p className="py-10 text-center text-sm text-muted-foreground">No models match</p>
      )}
    </div>
  );
}
