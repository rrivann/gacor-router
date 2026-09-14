import { useState } from "react";
import { ChevronDown, ChevronUp, Loader2, RefreshCw } from "lucide-react";
import { Button } from "../ui/button";
import type { CreditUsage, UsagePackage } from "../../lib/api";
import { cn } from "../../lib/utils";

function fmt(n: number): string {
  return Number.isInteger(n) ? n.toLocaleString() : n.toFixed(1);
}

function daysUntil(unix?: number): number | null {
  if (!unix) return null;
  const days = Math.ceil((unix * 1000 - Date.now()) / 86_400_000);
  return days >= 0 ? days : null;
}

function barTone(pct: number): string {
  if (pct <= 10) return "bg-error";
  if (pct <= 40) return "bg-warning";
  return "bg-success";
}

function UsageBar({
  label,
  sub,
  remaining,
  limit,
  dim,
}: {
  label: string;
  sub?: string;
  remaining: number;
  limit: number;
  dim?: boolean;
}) {
  const pct = limit > 0 ? Math.max(0, Math.min(100, (remaining / limit) * 100)) : 0;
  return (
    <div className={cn("space-y-0.5", dim && "opacity-75")}>
      <div className="flex items-center justify-between text-[10px] text-muted-foreground">
        <span className="max-w-[130px] truncate font-medium" title={label}>
          {label}
        </span>
        <span className="shrink-0 tabular-nums">
          {fmt(remaining)}/{fmt(limit)}
          {sub && <span className="ml-1 opacity-75">· {sub}</span>}
        </span>
      </div>
      <div className="h-1 w-full overflow-hidden rounded-full bg-secondary">
        <div className={cn("h-full rounded-full", barTone(pct))} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

// Credit cell for the accounts table, mirroring the enowx layout: a total
// bar on top, and a per-package breakdown (monthly plan + bonus packs) that
// expands underneath.
export function CreditCell({
  usage,
  usageAt,
  onRefresh,
}: {
  usage: CreditUsage | null;
  usageAt: string | null;
  onRefresh: () => Promise<void>;
}) {
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function handleRefresh() {
    setBusy(true);
    setErr(null);
    try {
      await onRefresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  if (!usage) {
    return (
      <div className="flex items-center gap-1.5">
        <Button variant="outline" size="sm" onClick={handleRefresh} disabled={busy}>
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
          Load
        </Button>
        {err && <span className="max-w-[140px] truncate text-xs text-error" title={err}>err</span>}
      </div>
    );
  }

  const resetDays = daysUntil(usage.resetAtUnix);
  const packages = usage.packages ?? [];
  const monthly = packages.filter((p) => p.kind === "monthly");
  const lifetime = packages.filter((p) => p.kind !== "monthly");
  const stale = usageAt && Date.now() - new Date(usageAt).getTime() > 10 * 60 * 1000;

  return (
    <div className="min-w-[210px] space-y-1.5">
      {/* Total bar */}
      <div className="space-y-0.5">
        <div className="flex items-center justify-between text-[10px] text-muted-foreground">
          <span className="font-medium">
            credit left{resetDays != null && <span className="ml-1">· resets {resetDays}d</span>}
          </span>
          <span className="flex items-center gap-1">
            <span className="tabular-nums">
              {fmt(usage.remaining)}/{fmt(usage.limit)}
            </span>
            <button
              onClick={handleRefresh}
              disabled={busy}
              className="rounded p-0.5 hover:bg-secondary hover:text-foreground"
              title={usageAt ? `Fetched ${new Date(usageAt).toLocaleTimeString()}` : "Refresh"}
            >
              <RefreshCw className={cn("h-3 w-3", busy && "animate-spin", stale && "text-warning")} />
            </button>
          </span>
        </div>
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-secondary">
          <div
            className={cn("h-full rounded-full", barTone(usage.limit > 0 ? (usage.remaining / usage.limit) * 100 : 0))}
            style={{ width: `${usage.limit > 0 ? (usage.remaining / usage.limit) * 100 : 0}%` }}
          />
        </div>
      </div>

      {/* Package breakdown toggle */}
      {packages.length > 0 && (
        <button
          onClick={() => setExpanded((v) => !v)}
          className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground"
        >
          {expanded ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
          {packages.length} package{packages.length !== 1 ? "s" : ""}
          {usage.plan && <span className="opacity-75">· {usage.plan}</span>}
        </button>
      )}

      {expanded && (
        <div className="space-y-1.5 border-l border-border pl-2 pt-0.5">
          {monthly.map((p, i) => (
            <PackageBar key={`m-${i}`} pkg={p} monthly />
          ))}
          {lifetime.map((p, i) => (
            <PackageBar key={`l-${i}`} pkg={p} />
          ))}
        </div>
      )}
      {err && <div className="text-[10px] text-error">{err}</div>}
    </div>
  );
}

function PackageBar({ pkg, monthly }: { pkg: UsagePackage; monthly?: boolean }) {
  const days = daysUntil(pkg.resetAtUnix);
  const sub = monthly
    ? `monthly${days != null ? ` · ${days}d` : ""}`
    : days != null
      ? `${days}d left`
      : undefined;
  return <UsageBar label={pkg.name} sub={sub} remaining={pkg.remaining} limit={pkg.limit} dim={!monthly} />;
}
