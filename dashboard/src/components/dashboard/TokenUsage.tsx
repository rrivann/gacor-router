import { useCallback, useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";
import { fetchUsage, type UsageRange, type UsageReport } from "../../lib/api";
import { cn, formatTokens, modelColor } from "../../lib/utils";
import { useWsEvent } from "../../hooks/useWebSocket";

const RANGES: UsageRange[] = ["1d", "7d", "30d", "all"];

function bucketLabel(t: number, range: UsageRange): string {
  const d = new Date(t);
  if (range === "1d") return d.toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit", hour12: false });
  if (range === "all") return d.toLocaleDateString("id-ID", { month: "short" });
  return d.toLocaleDateString("id-ID", { day: "2-digit", month: "short" });
}

// Token Usage card (etteum pattern): range pills, three totals, a bar chart
// over time, and the per-model breakdown.
export function TokenUsage() {
  const [range, setRange] = useState<UsageRange>("1d");
  const [report, setReport] = useState<UsageReport | null>(null);

  const load = useCallback(async () => {
    try {
      setReport(await fetchUsage(range));
    } catch {
      setReport(null);
    }
  }, [range]);

  useEffect(() => {
    load();
  }, [load]);

  // A finished request nudges the chart — debounced so bursts don't spam.
  useWsEvent("request_log", () => {
    const t = setTimeout(load, 600);
    return () => clearTimeout(t);
  });

  const rawBuckets = report?.buckets ?? [];
  // Fill gaps: a range with requests at 07:00 and 15:00 should still render
  // the dead hours between as zero-height bars, so the timeline reads true.
  const buckets = (() => {
    if (rawBuckets.length === 0) return [];
    const stepMs = range === "1d" ? 3600_000 : range === "all" ? 30 * 86_400_000 : 86_400_000;
    const byTime = new Map(rawBuckets.map((b) => {
      const key = Math.floor(b.t / stepMs) * stepMs;
      return [key, b] as const;
    }));
    const start = Math.floor(rawBuckets[0]!.t / stepMs) * stepMs;
    const end = Math.floor(rawBuckets[rawBuckets.length - 1]!.t / stepMs) * stepMs;
    const out = [];
    for (let t = start; t <= end; t += stepMs) {
      out.push(
        byTime.get(t) ?? { t, promptTokens: 0, completionTokens: 0, totalTokens: 0, requests: 0 }
      );
    }
    return out;
  })();
  const max = Math.max(1, ...buckets.map((b) => b.totalTokens));
  const models = (report?.models ?? []).filter((m) => m.totalTokens > 0 || m.requests > 0).slice(0, 8);
  const maxModel = Math.max(1, ...models.map((m) => m.totalTokens));

  // Axis ticks: up to 8 evenly spaced bucket labels.
  const tickEvery = Math.max(1, Math.ceil(buckets.length / 8));

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <CardTitle>Token Usage</CardTitle>
        <div className="flex gap-1">
          {RANGES.map((r) => (
            <button
              key={r}
              onClick={() => setRange(r)}
              className={cn(
                "rounded-md border px-2.5 py-1 text-xs transition-colors",
                range === r
                  ? "border-primary/50 bg-primary/15 text-primary"
                  : "border-border text-secondary-foreground hover:bg-secondary hover:text-foreground"
              )}
            >
              {r}
            </button>
          ))}
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        {/* Three totals */}
        <div className="grid grid-cols-3 gap-3">
          {[
            { label: "TOTAL", value: report?.total ?? 0 },
            { label: "PROMPT", value: report?.prompt ?? 0 },
            { label: "COMPLETION", value: report?.completion ?? 0 },
          ].map((s) => (
            <div key={s.label} className="rounded-lg border border-border bg-background p-3">
              <div className="text-lg font-bold tabular-nums">{formatTokens(s.value)}</div>
              <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{s.label}</div>
            </div>
          ))}
        </div>

        {/* Bar chart over time */}
        <div>
          <p className="mb-2 text-xs font-medium text-muted-foreground">Token Usage Over Time</p>
          {buckets.length === 0 ? (
            <div className="flex h-36 items-center justify-center rounded-lg border border-dashed border-border text-sm text-muted-foreground">
              No usage in this range
            </div>
          ) : (
            <div>
              <div className="flex h-36 items-end gap-px">
                {buckets.map((b, i) => (
                  <div
                    key={b.t}
                    className="group relative flex h-full flex-1 flex-col justify-end"
                    title={`${bucketLabel(b.t, range)} · ${formatTokens(b.totalTokens)} tokens · ${b.requests} req`}
                  >
                    <div
                      className="w-full rounded-t bg-primary/70 transition-colors group-hover:bg-primary"
                      style={{ height: `${Math.max(2, (b.totalTokens / max) * 100)}%` }}
                    />
                    {i % tickEvery === 0 && (
                      <span className="absolute -bottom-5 left-1/2 -translate-x-1/2 whitespace-nowrap text-[9px] text-muted-foreground">
                        {bucketLabel(b.t, range)}
                      </span>
                    )}
                  </div>
                ))}
              </div>
              <div className="h-5" />
            </div>
          )}
        </div>

        {/* By model */}
        <div>
          <p className="mb-2 text-xs font-medium text-muted-foreground">By Model</p>
          {models.length === 0 ? (
            <p className="py-2 text-sm text-muted-foreground">No model usage yet</p>
          ) : (
            <div className="space-y-2">
              {models.map((m, i) => (
                <div key={`${m.provider}/${m.model}`} className="space-y-1">
                  <div className="flex items-center justify-between text-xs">
                    <span className="truncate font-medium">
                      {m.provider}/{m.model}
                    </span>
                    <span className="text-muted-foreground tabular-nums">
                      {formatTokens(m.totalTokens)} · {m.requests} req
                    </span>
                  </div>
                  <div className="h-1.5 w-full overflow-hidden rounded-full bg-secondary">
                    <div
                      className="h-full rounded-full"
                      style={{
                        width: `${(m.totalTokens / maxModel) * 100}%`,
                        background: modelColor(`${m.provider}/${m.model}`, i),
                      }}
                    />
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
