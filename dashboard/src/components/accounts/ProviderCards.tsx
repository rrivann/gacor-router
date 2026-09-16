import { Flame, Loader2, Plus, RefreshCw, Settings } from "lucide-react";
import type { AccountRow } from "../../lib/api";
import { cn } from "../../lib/utils";
import { ProviderIcon } from "./ProviderIcon";

interface ProviderStats {
  total: number;
  active: number;
  exhausted: number;
  banned: number;
  creditRemaining: number;
  creditLimit: number;
  hasCredit: boolean;
}

export function computeStats(accounts: AccountRow[], provider: string): ProviderStats {
  const rows = accounts.filter((a) => a.provider === provider);
  const s: ProviderStats = {
    total: rows.length,
    active: 0,
    exhausted: 0,
    banned: 0,
    creditRemaining: 0,
    creditLimit: 0,
    hasCredit: false,
  };
  for (const a of rows) {
    if (a.status === "active") s.active++;
    else if (a.status === "exhausted") s.exhausted++;
    else if (a.status === "banned") s.banned++;
    if (a.usage && a.usage.limit > 0) {
      s.hasCredit = true;
      s.creditRemaining += a.usage.remaining;
      s.creditLimit += a.usage.limit;
    }
  }
  return s;
}

function fmt(n: number): string {
  return Number.isInteger(n) ? n.toLocaleString() : n.toFixed(1);
}

function Chip({ n, label, tone }: { n: number; label: string; tone: "success" | "warning" | "error" | "muted" }) {
  if (n === 0) return null;
  const colors = {
    success: "bg-success/15 text-success",
    warning: "bg-warning/15 text-warning",
    error: "bg-error/15 text-error",
    muted: "bg-secondary text-muted-foreground",
  }[tone];
  return (
    <span className={cn("rounded-md px-1.5 py-0.5 text-[10px] font-medium tabular-nums", colors)}>
      {n} {label}
    </span>
  );
}

// Provider summary card (etteum/enowx hybrid): status chips, credit summary,
// quick add + settings gear (opens the provider settings modal). The whole
// card selects the provider filter.
export function ProviderCards({
  providers,
  accounts,
  selected,
  rotation,
  retrying,
  warming,
  onSelect,
  onAdd,
  onRetry,
  onWarm,
  onOpenSettings,
}: {
  providers: string[];
  accounts: AccountRow[];
  selected: string; // "all" or a provider name
  rotation: Record<string, string>;
  retrying: Record<string, boolean>;
  warming: Record<string, boolean>;
  onSelect: (provider: string) => void;
  onAdd: (provider: string) => void;
  onRetry: (provider: string) => void;
  onWarm: (provider: string) => void;
  onOpenSettings: (provider: string) => void;
}) {
  // Empty providers array = no known providers configured. Callers normally
  // seed a known-providers list (see Accounts.tsx) so this branch stays cold.
  if (providers.length === 0) return null;
  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
      {providers.map((p) => {
        const s = computeStats(accounts, p);
        const active = selected === p;
        return (
          <div
            key={p}
            onClick={() => onSelect(active ? "all" : p)}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onSelect(active ? "all" : p);
              }
            }}
            className={cn(
              "group cursor-pointer rounded-xl border bg-card p-3.5 transition-all",
              active
                ? "border-primary/60 shadow-[var(--glow)]"
                : "border-border hover:border-primary/40"
            )}
          >
            <div className="flex items-start gap-3">
              <ProviderIcon provider={p} size={40} />
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline justify-between gap-2">
                  <p className="truncate text-sm font-semibold capitalize">{p}</p>
                  <span className="shrink-0 rounded-md bg-secondary px-1.5 py-0.5 text-[10px] text-muted-foreground tabular-nums">
                    {s.total} {s.total === 1 ? "account" : "accounts"}
                  </span>
                </div>
                <div className="mt-1.5 flex flex-wrap items-center gap-1">
                  <Chip n={s.active} label="active" tone="success" />
                  <Chip n={s.exhausted} label="exhausted" tone="warning" />
                  <Chip n={s.banned} label="banned" tone="error" />
                  {s.total === 0 && <span className="text-[10px] text-muted-foreground">no accounts yet</span>}
                </div>
              </div>
            </div>

            {/* Credit summary */}
            <div className="mt-2.5 flex items-center justify-between text-[10px] text-muted-foreground">
              <span>Credits</span>
              <span className="tabular-nums">
                {s.hasCredit ? `${fmt(s.creditRemaining)} / ${fmt(s.creditLimit)} remaining` : "—"}
              </span>
            </div>
            {s.hasCredit && (
              <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-secondary">
                <div
                  className={cn(
                    "h-full rounded-full",
                    s.creditLimit > 0 && s.creditRemaining / s.creditLimit <= 0.1
                      ? "bg-error"
                      : s.creditLimit > 0 && s.creditRemaining / s.creditLimit <= 0.4
                        ? "bg-warning"
                        : "bg-success"
                  )}
                  style={{ width: `${s.creditLimit > 0 ? (s.creditRemaining / s.creditLimit) * 100 : 0}%` }}
                />
              </div>
            )}

            <div className="mt-3 flex items-center gap-1.5">
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onAdd(p);
                }}
                className="flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-border bg-secondary/60 py-1.5 text-xs font-medium text-secondary-foreground transition-colors hover:bg-secondary hover:text-foreground"
              >
                <Plus className="h-3.5 w-3.5" /> Add account
              </button>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onWarm(p);
                }}
                disabled={s.total === 0 || warming[p]}
                title={s.total === 0 ? "No accounts to warm" : `Warmup all ${p} accounts`}
                className="shrink-0 rounded-lg border border-border bg-secondary/60 p-1.5 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
              >
                {warming[p] ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Flame className="h-3.5 w-3.5" />
                )}
              </button>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onRetry(p);
                }}
                disabled={s.total === 0 || retrying[p]}
                title={s.total === 0 ? "No accounts to retry" : `Refresh credit for all ${p} accounts`}
                className="shrink-0 rounded-lg border border-border bg-secondary/60 p-1.5 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
              >
                <RefreshCw className={cn("h-3.5 w-3.5", retrying[p] && "animate-spin")} />
              </button>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onOpenSettings(p);
                }}
                title={`Provider settings (rotation: ${rotation[p] === "round-robin" ? "round-robin" : "sticky"})`}
                className={cn(
                  "shrink-0 rounded-lg border p-1.5 transition-colors",
                  rotation[p] === "round-robin"
                    ? "border-primary/50 bg-primary/15 text-primary"
                    : "border-border bg-secondary/60 text-muted-foreground hover:bg-secondary hover:text-foreground"
                )}
              >
                <Settings className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
