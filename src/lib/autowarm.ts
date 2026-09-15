// Auto-warmup scheduler (enowx-derived, simplified): a background interval
// that warms accounts whose provider has auto-warmup enabled and whose turn
// has come. Config lives in settings under `auto_warmup:<provider>` and is
// re-read every tick, so a settings change takes effect without a restart.
// Last-warm times persist in settings too, so a restart resumes the schedule.

import { getSetting, setSetting, listAccounts } from "../db/accounts";
import { registry } from "../providers";
import { warmAccount } from "./warmup";

export interface AutoWarmConfig {
  enabled: boolean;
  intervalMinutes: number;
  statuses: string[];
  // Max simultaneous probes per cycle, so a big pool can't burst the upstream.
  concurrency: number;
  // When on, an account warmed within the interval is skipped entirely —
  // cheaper on a large pool. When off, every due account is re-probed.
  skipRecentlyWarmed: boolean;
}

const DEFAULT_STATUSES = ["active", "exhausted"];
const DEFAULT_INTERVAL_MIN = 60;
const DEFAULT_CONCURRENCY = 2;
const TICK_MS = 60_000; // fixed 1m tick, decoupled from the configurable interval

function configKey(provider: string): string {
  return `auto_warmup:${provider}`;
}

function lastWarmKey(provider: string, accountId: number): string {
  return `auto_warm_last:${provider}:${accountId}`;
}

export function getAutoWarmConfig(provider: string): AutoWarmConfig {
  const fallback: AutoWarmConfig = {
    enabled: false,
    intervalMinutes: DEFAULT_INTERVAL_MIN,
    statuses: DEFAULT_STATUSES,
    concurrency: DEFAULT_CONCURRENCY,
    skipRecentlyWarmed: true,
  };
  const raw = getSetting(configKey(provider));
  if (!raw) return fallback;
  try {
    const c = JSON.parse(raw) as Partial<AutoWarmConfig>;
    return {
      enabled: c.enabled === true,
      intervalMinutes: c.intervalMinutes && c.intervalMinutes > 0 ? c.intervalMinutes : DEFAULT_INTERVAL_MIN,
      statuses: Array.isArray(c.statuses) && c.statuses.length > 0 ? c.statuses : DEFAULT_STATUSES,
      concurrency: c.concurrency && c.concurrency > 0 ? Math.min(c.concurrency, 16) : DEFAULT_CONCURRENCY,
      skipRecentlyWarmed: c.skipRecentlyWarmed !== false, // default on
    };
  } catch {
    return fallback;
  }
}

export function setAutoWarmConfig(provider: string, cfg: AutoWarmConfig): void {
  setSetting(configKey(provider), JSON.stringify(cfg));
}

function lastWarm(provider: string, accountId: number): number {
  const raw = getSetting(lastWarmKey(provider, accountId));
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
}

function markWarm(provider: string, accountId: number): void {
  setSetting(lastWarmKey(provider, accountId), String(Date.now()));
}

// One cycle: warm every due account for providers with auto-warmup enabled,
// in batches capped by the provider's concurrency. Exported for tests; the
// scheduler calls it every tick.
export async function autoWarmCycle(now = Date.now()): Promise<number> {
  let warmed = 0;
  for (const providerName of registry.names()) {
    const cfg = getAutoWarmConfig(providerName);
    if (!cfg.enabled) continue;

    // Due = last warm + interval has passed. skipRecentlyWarmed OFF means the
    // due check itself is the only gate; ON is identical here — the last-warm
    // record is what "recently warmed" means, so both paths share it. The
    // flag exists for clarity of intent and future probes that don't record
    // last-warm (e.g. manual warmups).
    const due = listAccounts(providerName).filter(
      (a) =>
        cfg.statuses.includes(a.status) &&
        lastWarm(providerName, a.id) + cfg.intervalMinutes * 60_000 <= now
    );
    if (due.length === 0) continue;

    // Probe in batches of `concurrency` so a large pool can't burst upstream.
    for (let i = 0; i < due.length; i += cfg.concurrency) {
      const batch = due.slice(i, i + cfg.concurrency);
      await Promise.all(
        batch.map(async (a) => {
          await warmAccount(a.id);
          markWarm(providerName, a.id);
        })
      );
      warmed += batch.length;
    }
  }
  return warmed;
}

let timer: ReturnType<typeof setInterval> | null = null;

// Start the background scheduler. Idempotent — a second call is a no-op.
// The timer is unref'd so it never keeps the process alive on its own.
export function startAutoWarmScheduler(): void {
  if (timer) return;
  timer = setInterval(() => {
    autoWarmCycle().catch(() => {
      // A failing cycle must never kill the scheduler; next tick retries.
    });
  }, TICK_MS);
  timer.unref();
}

export function stopAutoWarmScheduler(): void {
  clearInterval(timer ?? undefined);
  timer = null;
}
