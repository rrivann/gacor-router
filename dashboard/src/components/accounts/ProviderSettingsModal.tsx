import { useEffect, useState } from "react";
import { Check, Flame, Loader2, RefreshCw, Settings, X } from "lucide-react";
import { refreshUsage, fetchAutoWarmConfig, saveAutoWarmConfig, type AutoWarmConfig } from "../../lib/api";
import type { AccountRow } from "../../lib/api";
import { cn } from "../../lib/utils";
import { Toggle } from "../ui/toggle";

// Per-provider settings popup (enowx RotationModal, adapted): account
// rotation choice plus a maintenance section — here, a one-shot credit
// refresh across the provider's accounts (we have no warmup bot).
export function ProviderSettingsModal({
  provider,
  rotation,
  accounts,
  onRotationChange,
  onClose,
  onError,
}: {
  provider: string;
  rotation: string | undefined; // "round-robin" | undefined (sticky)
  accounts: AccountRow[];
  onRotationChange: (provider: string, roundRobin: boolean) => Promise<void>;
  onClose: () => void;
  onError: (err: unknown) => void;
}) {
  const mode = rotation === "round-robin" ? "round-robin" : "sticky";
  const [savingMode, setSavingMode] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshed, setRefreshed] = useState<number | null>(null);
  const [autoWarm, setAutoWarm] = useState<AutoWarmConfig | null>(null);
  const [savingWarm, setSavingWarm] = useState(false);

  useEffect(() => {
    fetchAutoWarmConfig(provider).then(setAutoWarm).catch(() => setAutoWarm(null));
  }, [provider]);

  async function setWarm(patch: Partial<AutoWarmConfig>) {
    if (!autoWarm || savingWarm) return;
    setSavingWarm(true);
    const optimistic = { ...autoWarm, ...patch };
    setAutoWarm(optimistic);
    try {
      setAutoWarm(await saveAutoWarmConfig(provider, patch));
    } catch {
      setAutoWarm(autoWarm); // revert on failure
    } finally {
      setSavingWarm(false);
    }
  }

  async function set(m: "sticky" | "round-robin") {
    if (m === mode || savingMode) return;
    setSavingMode(true);
    try {
      await onRotationChange(provider, m === "round-robin");
    } finally {
      setSavingMode(false);
    }
  }

  async function refreshAll() {
    const ids = accounts.filter((a) => a.provider === provider).map((a) => a.id);
    if (ids.length === 0 || refreshing) return;
    setRefreshing(true);
    setRefreshed(null);
    let okCount = 0;
    try {
      for (const id of ids) {
        try {
          await refreshUsage(id);
          okCount++;
        } catch (err) {
          onError(err);
        }
      }
      setRefreshed(okCount);
    } finally {
      setRefreshing(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/70 p-4" onClick={onClose}>
      <div
        className="max-h-[85vh] w-full max-w-sm overflow-y-auto rounded-2xl border border-border bg-popover p-4 shadow-[var(--shadow-card)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-1 flex items-center justify-between">
          <div className="flex items-center gap-2 text-sm font-semibold">
            <Settings className="h-4 w-4 text-muted-foreground" /> Provider settings
          </div>
          <button onClick={onClose} className="rounded-md p-1 text-muted-foreground hover:bg-secondary hover:text-foreground">
            <X className="h-4 w-4" />
          </button>
        </div>
        <p className="capitalize text-xs text-muted-foreground">{provider}</p>

        <p className="mb-2 mt-4 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          Account rotation
        </p>
        <p className="mb-3 text-[11px] leading-snug text-muted-foreground">
          How the next account is chosen for each request. Either way, a failed account is skipped
          automatically and in-flight streams are never interrupted.
        </p>

        <div className="space-y-2">
          <ModeButton
            active={mode === "sticky"}
            title="Sticky"
            desc="Keep using one account; only move to the next when it stops working. Default."
            onClick={() => set("sticky")}
          />
          <ModeButton
            active={mode === "round-robin"}
            title="Round-robin"
            desc="Rotate through all accounts each request to spread the load."
            onClick={() => set("round-robin")}
          />
        </div>
        {savingMode && (
          <div className="mt-2 flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" /> Saving…
          </div>
        )}

        <div className="mt-4 border-t border-border pt-3">
          <p className="mb-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            Maintenance
          </p>

          {/* Auto warm-up (enowx): background scheduler probes accounts on a
              schedule so status + credits stay accurate. */}
          <div className={cn(
            "rounded-xl border p-3 transition-colors",
            autoWarm?.enabled ? "border-warning/40 bg-warning/5" : "border-border"
          )}>
            <div className="flex items-center gap-2.5">
              <Flame className="h-4 w-4 shrink-0 text-warning" />
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium">Auto warm-up</span>
                <span className="block text-[11px] text-muted-foreground">
                  Re-probe this provider's accounts on a schedule to keep their status accurate.
                </span>
              </span>
              {autoWarm ? (
                <Toggle
                  checked={autoWarm.enabled}
                  onChange={(next) => setWarm({ enabled: next })}
                  disabled={savingWarm}
                  label="Auto warm-up"
                />
              ) : (
                <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
              )}
            </div>

            {autoWarm?.enabled && (
              <div className="mt-3 space-y-3 border-t border-border/60 pt-3">
                {/* Interval pills */}
                <PillGroup
                  label="Every"
                  hint="how often each account is re-probed"
                  options={INTERVALS}
                  value={String(autoWarm.intervalMinutes)}
                  onPick={(v) => setWarm({ intervalMinutes: Number(v) })}
                  render={(v) => (Number(v) >= 60 ? `${Number(v) / 60}h` : `${v}m`)}
                />

                {/* Status pills (multi-select) */}
                <div>
                  <div className="mb-1.5 flex items-baseline gap-2">
                    <span className="text-xs font-medium">Warm accounts that are</span>
                    <span className="text-[10px] text-muted-foreground">which statuses are eligible</span>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {["active", "exhausted", "error", "banned"].map((s) => {
                      const on = autoWarm.statuses.includes(s);
                      return (
                        <button
                          key={s}
                          onClick={() =>
                            setWarm({
                              statuses: on
                                ? autoWarm.statuses.filter((x) => x !== s)
                                : [...autoWarm.statuses, s],
                            })
                          }
                          className={cn(
                            "rounded-md border px-2.5 py-1 text-xs capitalize transition-colors",
                            on
                              ? "border-primary/50 bg-primary/15 text-primary"
                              : "border-border text-secondary-foreground hover:bg-secondary"
                          )}
                        >
                          {s}
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* Concurrency pills */}
                <PillGroup
                  label="At most"
                  hint="simultaneous probes, so a big pool can't burst"
                  options={CONCURRENCIES}
                  value={String(autoWarm.concurrency)}
                  onPick={(v) => setWarm({ concurrency: Number(v) })}
                  render={(v) => `${v}×`}
                />

                {/* Skip recently warmed */}
                <div className="flex items-center gap-2.5">
                  <span className="min-w-0 flex-1">
                    <span className="block text-xs font-medium">Skip recently warmed</span>
                    <span className="block text-[10px] leading-snug text-muted-foreground">
                      Don't re-probe an account that was already warmed within the interval — cheaper
                      on a large pool.
                    </span>
                  </span>
                  <Toggle
                    checked={autoWarm.skipRecentlyWarmed}
                    onChange={(next) => setWarm({ skipRecentlyWarmed: next })}
                    disabled={savingWarm}
                    label="Skip recently warmed"
                  />
                </div>
              </div>
            )}
          </div>

          <button
            onClick={refreshAll}
            disabled={refreshing}
            className="mt-2 flex w-full items-center gap-2.5 rounded-xl border border-border p-3 text-left transition-colors hover:bg-secondary/60 disabled:opacity-60"
          >
            <RefreshCw className={cn("h-4 w-4 shrink-0 text-muted-foreground", refreshing && "animate-spin")} />
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium">Refresh all credits</span>
              <span className="block text-[11px] text-muted-foreground">
                Re-fetch the billing snapshot for every {provider} account now.
              </span>
            </span>
            {refreshed !== null && !refreshing && (
              <span className="shrink-0 text-[11px] text-success">{refreshed} updated</span>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

function ModeButton({
  active,
  title,
  desc,
  onClick,
}: {
  active: boolean;
  title: string;
  desc: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "w-full rounded-xl border p-3 text-left transition-colors",
        active ? "border-primary/50 bg-primary/10" : "border-border hover:bg-secondary/60"
      )}
    >
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium">{title}</span>
        {active && <Check className="h-4 w-4 text-primary" />}
      </div>
      <p className="mt-0.5 text-[11px] text-muted-foreground">{desc}</p>
    </button>
  );
}

const INTERVALS = ["15", "30", "60", "180", "360", "720", "1440"];
const CONCURRENCIES = ["1", "2", "4", "8"];

// Single-select pill row with a label + hint, used for interval/concurrency.
function PillGroup({
  label,
  hint,
  options,
  value,
  onPick,
  render,
}: {
  label: string;
  hint: string;
  options: string[];
  value: string;
  onPick: (v: string) => void;
  render: (v: string) => string;
}) {
  return (
    <div>
      <div className="mb-1.5 flex items-baseline gap-2">
        <span className="text-xs font-medium">{label}</span>
        <span className="text-[10px] text-muted-foreground">{hint}</span>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {options.map((opt) => {
          const active = opt === value;
          return (
            <button
              key={opt}
              onClick={() => onPick(opt)}
              className={cn(
                "rounded-md border px-2.5 py-1 text-xs tabular-nums transition-colors",
                active
                  ? "border-primary/50 bg-primary/15 text-primary"
                  : "border-border text-secondary-foreground hover:bg-secondary"
              )}
            >
              {render(opt)}
            </button>
          );
        })}
      </div>
    </div>
  );
}
