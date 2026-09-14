import { useCallback, useEffect, useRef, useState } from "react";
import { Users, Activity, CheckCircle, Zap, CircleAlert, Ban } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import {
  fetchDashboardStats,
  fetchModelUsage,
  type DashboardStats,
  type ModelUsageRow,
} from "../lib/api";
import { cn, formatTokens, modelColor } from "../lib/utils";
import { useWsEvent } from "../hooks/useWebSocket";

export default function Dashboard() {
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [models, setModels] = useState<ModelUsageRow[]>([]);

  const load = useCallback(async () => {
    const [s, m] = await Promise.all([
      fetchDashboardStats().catch(() => null),
      fetchModelUsage().then((r) => r.data).catch(() => [] as ModelUsageRow[]),
    ]);
    setStats(s);
    setModels(m);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Debounce: a burst of request_log events collapses into one reload.
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useWsEvent(["request_log", "account_status"], () => {
    clearTimeout(timer.current ?? undefined);
    timer.current = setTimeout(load, 400);
  });

  const total = stats?.requests.total ?? 0;
  const success = stats?.requests.success ?? 0;
  const rate = total > 0 ? ((success / total) * 100).toFixed(1) : "0.0";

  const cards = [
    {
      label: "Accounts",
      value: `${stats?.pool.active ?? 0}/${stats?.pool.total ?? 0}`,
      sub: "active",
      icon: Users,
      color: "text-chart-2",
      bg: "bg-chart-2/10",
    },
    {
      label: "Requests",
      value: total.toLocaleString(),
      sub: "all time",
      icon: Activity,
      color: "text-chart-3",
      bg: "bg-chart-3/10",
    },
    {
      label: "Success Rate",
      value: `${rate}%`,
      sub: "all time",
      icon: CheckCircle,
      color: "text-success",
      bg: "bg-success/10",
    },
    {
      label: "Total Tokens",
      value: formatTokens(stats?.tokens.total ?? 0),
      sub: `${formatTokens(stats?.tokens.prompt ?? 0)} in · ${formatTokens(stats?.tokens.completion ?? 0)} out`,
      icon: Zap,
      color: "text-warning",
      bg: "bg-warning/10",
    },
  ];

  const topModels = models.filter((m) => m.totalTokens > 0 || m.requests > 0).slice(0, 8);
  const maxTokens = Math.max(1, ...topModels.map((m) => m.totalTokens));

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Dashboard</h1>
        <p className="mt-1 text-sm text-muted-foreground">Pool status at a glance</p>
      </div>

      {/* Stat cards */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4">
        {cards.map((c) => (
          <Card key={c.label} className="group transition-all hover:border-primary/40">
            <CardContent className="p-4">
              <div className="flex items-center justify-between">
                <div className="min-w-0">
                  <p className="text-xs uppercase tracking-wide text-muted-foreground">{c.label}</p>
                  <p className="mt-1 text-2xl font-bold tabular-nums">{c.value}</p>
                  <p className="mt-1 truncate text-xs text-muted-foreground">{c.sub}</p>
                </div>
                <div className={cn("rounded-xl p-3 transition-transform group-hover:scale-105", c.bg)}>
                  <c.icon className={cn("h-5 w-5", c.color)} />
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* Pool health */}
        <Card>
          <CardHeader>
            <CardTitle>Pool Health</CardTitle>
            <CardDescription>Account states across providers</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {[
              { label: "Active", value: stats?.pool.active ?? 0, icon: CheckCircle, tone: "text-success" },
              { label: "Exhausted", value: stats?.pool.exhausted ?? 0, icon: CircleAlert, tone: "text-warning" },
              { label: "Banned", value: stats?.pool.banned ?? 0, icon: Ban, tone: "text-error" },
            ].map((row) => (
              <div key={row.label} className="flex items-center justify-between text-sm">
                <span className="flex items-center gap-2 text-secondary-foreground">
                  <row.icon className={cn("h-4 w-4", row.tone)} />
                  {row.label}
                </span>
                <span className="font-semibold tabular-nums">{row.value}</span>
              </div>
            ))}
          </CardContent>
        </Card>

        {/* Token usage by model */}
        <Card>
          <CardHeader>
            <CardTitle>Token Usage by Model</CardTitle>
            <CardDescription>Top consumers, all time</CardDescription>
          </CardHeader>
          <CardContent>
            {topModels.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">
                No requests yet — send one via /v1/chat/completions
              </p>
            ) : (
              <div className="space-y-3">
                {topModels.map((m, i) => (
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
                          width: `${(m.totalTokens / maxTokens) * 100}%`,
                          background: modelColor(`${m.provider}/${m.model}`, i),
                        }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
