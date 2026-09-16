import { useCallback, useEffect, useState } from "react";
import { RefreshCw, Search, X } from "lucide-react";
import { Card } from "../components/ui/card";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Input, Select } from "../components/ui/input";
import {
  fetchRequestDetail,
  fetchRequestLogs,
  type RequestLogDetail,
  type RequestLogRow,
} from "../lib/api";
import { cn, formatDateTime, formatDuration, formatTokens } from "../lib/utils";
import { useWsEvent } from "../hooks/useWebSocket";

function statusVariant(status: string, httpStatus: number | null): "success" | "warning" | "error" {
  if (status === "success") return "success";
  if (httpStatus === 429) return "warning";
  return "error";
}

export default function Requests() {
  const [logs, setLogs] = useState<RequestLogRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [provider, setProvider] = useState("all");
  const [selected, setSelected] = useState<RequestLogDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetchRequestLogs({ limit: 200, provider: provider === "all" ? undefined : provider });
      setLogs(res.data);
    } catch {
      setLogs([]);
    } finally {
      setLoading(false);
    }
  }, [provider]);

  useEffect(() => {
    load();
  }, [load]);

  // Live: new finished requests prepend themselves. The event shape matches
  // the list row minus createdAt/stream/outcome, which the next refresh
  // fills in.
  useWsEvent("request_log", (msg) => {
    const ev = msg.data as Partial<RequestLogRow> & { id: number };
    setLogs((current) => {
      if (current.some((r) => r.id === ev.id)) return current;
      const row: RequestLogRow = {
        createdAt: new Date().toISOString(),
        stream: false,
        source: "proxy",
        outcome: null,
        model: null,
        accountId: null,
        accountLabel: null,
        httpStatus: null,
        durationMs: null,
        promptTokens: null,
        completionTokens: null,
        totalTokens: null,
        cachedTokens: null,
        cacheWriteTokens: null,
        reasoningTokens: null,
        ttftMs: null,
        creditUsed: null,
        dollarCost: null,
        errorMessage: null,
        ...ev,
        provider: ev.provider ?? "",
        status: ev.status ?? "error",
      } as RequestLogRow;
      return [row, ...current].slice(0, 200);
    });
  });

  async function openDetail(row: RequestLogRow) {
    setDetailLoading(true);
    try {
      const res = await fetchRequestDetail(row.id);
      setSelected(res.data);
    } catch {
      setSelected(null);
    } finally {
      setDetailLoading(false);
    }
  }

  const providers = [...new Set(logs.map((l) => l.provider))].sort();
  const filtered = logs.filter((l) => {
    const q = search.toLowerCase();
    return (
      !q ||
      (l.model ?? "").toLowerCase().includes(q) ||
      l.provider.toLowerCase().includes(q) ||
      (l.errorMessage ?? "").toLowerCase().includes(q) ||
      (l.accountLabel ?? "").toLowerCase().includes(q)
    );
  });

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold">Requests</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Live request log — new entries appear as they finish
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={load} disabled={loading}>
          <RefreshCw className="h-4 w-4" /> Refresh
        </Button>
      </div>

      <div className="flex flex-col gap-3 sm:flex-row">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search model, provider, account, error…"
            className="pl-9"
          />
        </div>
        <Select value={provider} onChange={(e) => setProvider(e.target.value)} className="sm:w-48">
          <option value="all">All providers</option>
          {providers.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </Select>
      </div>

      <Card>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                <th className="px-4 py-3">Time</th>
                <th className="px-4 py-3">User</th>
                <th className="px-4 py-3">Model</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3 text-right">In</th>
                <th className="px-4 py-3 text-right">Cached</th>
                <th className="px-4 py-3 text-right">Out</th>
                <th className="px-4 py-3 text-right">TTFT</th>
                <th className="px-4 py-3 text-right">Latency</th>
                <th className="px-4 py-3 text-right">Credit</th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={10} className="px-4 py-10 text-center text-muted-foreground">
                    {loading ? "Loading…" : "No requests yet"}
                  </td>
                </tr>
              )}
              {filtered.map((l) => (
                <tr
                  key={l.id}
                  onClick={() => openDetail(l)}
                  className="cursor-pointer border-b border-border/60 last:border-0 hover:bg-secondary/40"
                  title={l.errorMessage ?? undefined}
                >
                  <td className="whitespace-nowrap px-4 py-2.5 text-xs text-muted-foreground">
                    {formatDateTime(l.createdAt)}
                  </td>
                  <td className="px-4 py-2.5 text-secondary-foreground">{l.accountLabel ?? "—"}</td>
                  <td className="max-w-[240px] px-4 py-2.5">
                    <div className="truncate font-medium">{l.model ?? "?"}</div>
                    <div className="text-[10px] text-muted-foreground">{l.provider}</div>
                  </td>
                  <td className="px-4 py-2.5">
                    <Badge variant={statusVariant(l.status, l.httpStatus)}>
                      {l.httpStatus ?? l.status}
                    </Badge>
                    {l.source === "warmup" && (
                      <Badge variant="secondary" className="ml-1">warmup</Badge>
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-right tabular-nums text-secondary-foreground">
                    {l.promptTokens != null ? formatTokens(l.promptTokens) : "—"}
                  </td>
                  <td
                    className="px-4 py-2.5 text-right tabular-nums text-muted-foreground"
                    title={
                      l.cachedTokens != null && l.cachedTokens > 0
                        ? `Read ${(l.cachedTokens - (l.cacheWriteTokens ?? 0)).toLocaleString()} · Write ${(l.cacheWriteTokens ?? 0).toLocaleString()}`
                        : undefined
                    }
                  >
                    {l.cachedTokens != null && l.cachedTokens > 0 ? formatTokens(l.cachedTokens) : "—"}
                  </td>
                  <td className="px-4 py-2.5 text-right tabular-nums text-secondary-foreground">
                    {l.completionTokens != null ? formatTokens(l.completionTokens) : "—"}
                  </td>
                  <td className="px-4 py-2.5 text-right tabular-nums text-muted-foreground">
                    {l.ttftMs != null ? formatDuration(l.ttftMs) : "—"}
                  </td>
                  <td className="px-4 py-2.5 text-right tabular-nums text-muted-foreground">
                    {formatDuration(l.durationMs)}
                  </td>
                  <td className="px-4 py-2.5 text-right tabular-nums">
                    {l.creditUsed != null && l.creditUsed > 0 ? (
                      <span className="text-primary">{l.creditUsed.toFixed(2)}</span>
                    ) : (
                      "—"
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      {/* Detail drawer */}
      {selected && (
        <div className="fixed inset-0 z-50 flex justify-end bg-black/60" onClick={() => setSelected(null)}>
          <div
            className="h-full w-full max-w-2xl overflow-y-auto border-l border-border bg-card p-5"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-4 flex items-start justify-between">
              <div>
                <h2 className="text-lg font-bold">
                  Request #{selected.id}
                  <Badge
                    variant={statusVariant(selected.status, selected.httpStatus)}
                    className="ml-2 align-middle"
                  >
                    {selected.httpStatus ?? selected.status}
                  </Badge>
                  {selected.source === "warmup" && (
                    <Badge variant="secondary" className="ml-1 align-middle">warmup</Badge>
                  )}
                </h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  {formatDateTime(selected.createdAt)} · {selected.provider}/{selected.model} ·{" "}
                  {selected.accountLabel ?? "no account"} · {formatDuration(selected.durationMs)}
                </p>
              </div>
              <button
                onClick={() => setSelected(null)}
                className="rounded-md p-1.5 text-muted-foreground hover:bg-secondary hover:text-foreground"
                aria-label="Close"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="mb-4 grid grid-cols-3 gap-3 text-center sm:grid-cols-4 lg:grid-cols-8">
              {[
                { label: "In", value: selected.promptTokens },
                {
                  label: "Cache Read",
                  value:
                    selected.cachedTokens != null
                      ? selected.cachedTokens - (selected.cacheWriteTokens ?? 0)
                      : null,
                },
                { label: "Cache Write", value: selected.cacheWriteTokens },
                { label: "Out", value: selected.completionTokens },
                { label: "Reasoning", value: selected.reasoningTokens },
                { label: "TTFT", value: selected.ttftMs, unit: "ms" as const },
                { label: "Latency", value: selected.durationMs, unit: "ms" as const },
                { label: "Credit", value: selected.creditUsed, credit: true },
                { label: "USD ~", value: selected.dollarCost, dollar: true },
              ].map((s) => (
                <div key={s.label} className="rounded-md border border-border bg-background p-3">
                  <div className={cn("text-lg font-bold tabular-nums", (s.credit || s.dollar) && s.value ? "text-primary" : "")}>
                    {s.value != null
                      ? s.credit
                        ? Number(s.value).toFixed(2)
                        : s.dollar
                          ? `$${Number(s.value).toFixed(4)}`
                          : s.unit === "ms"
                            ? formatDuration(s.value as number)
                            : s.value.toLocaleString()
                      : "—"}
                  </div>
                  <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{s.label}</div>
                </div>
              ))}
            </div>

            {selected.errorMessage && (
              <div className="mb-4 rounded-md border border-error/30 bg-error/10 px-3 py-2 text-sm text-error">
                {selected.errorMessage}
              </div>
            )}

            {detailLoading ? (
              <p className="text-sm text-muted-foreground">Loading bodies…</p>
            ) : (
              <div className="space-y-4">
                <BodyBlock title="Request" body={selected.requestBody} />
                <BodyBlock title="Response" body={selected.responseBody} />
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function BodyBlock({ title, body }: { title: string; body: string | null }) {
  if (!body) return null;
  let pretty = body;
  try {
    pretty = JSON.stringify(JSON.parse(body), null, 2);
  } catch {}
  return (
    <div>
      <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</h3>
      <pre
        className={cn(
          "max-h-96 overflow-auto rounded-md border border-border bg-background p-3",
          "text-xs leading-relaxed text-secondary-foreground"
        )}
      >
        {pretty}
      </pre>
    </div>
  );
}
