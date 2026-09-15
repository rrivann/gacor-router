// Process self-diagnostics for the dashboard debug popover. The Go/enowx
// equivalent reads runtime.MemStats + gopsutil; Bun gives us process
// equivalents — CPU% is computed from process.cpuUsage deltas between calls
// (the caller's poll cadence is the sampling window).

import { memoryUsage, cpuUsage, pid, uptime as processUptime, version as nodeVersion } from "node:process";
import { platform, arch, cpus } from "node:os";
import { performance } from "node:perf_hooks";

const startUsage = cpuUsage();
const startTime = performance.now();

// Event-loop delay: measured with a short setInterval probe on demand.
// A long delay means the loop is starved (heavy sync work).

export interface DebugProcess {
  process: { cpuPercent: number; rss: number; pid: number };
  memory: {
    heapUsed: number;
    heapTotal: number;
    external: number;
    arrayBuffers: number;
  };
  eventLoop: { delayMs: number };
  build: {
    bunVersion: string;
    nodeVersion: string;
    platform: string;
    arch: string;
    numCpu: number;
  };
  uptimeSeconds: number;
  now: string;
}

// Cumulative CPU since boot, normalized against wall time and core count.
// gopsutil's Percent(0) semantics, adapted: average utilization since start
// unless a previous sample exists, in which case it's the delta between
// samples — that's what makes the sparkline actually move.
let lastUsage = startUsage;
let lastTime = startTime;

function cpuPercent(): number {
  const u = cpuUsage();
  const now = performance.now();
  const du = {
    user: u.user - lastUsage.user,
    system: u.system - lastUsage.system,
  };
  const dtMs = now - lastTime;
  lastUsage = u;
  lastTime = now;
  if (dtMs <= 0) return 0;
  // cpuUsage is microseconds across all threads; normalize to one core.
  const pct = ((du.user + du.system) / 1000 / dtMs) * 100;
  return Math.round(pct * 10) / 10;
}

let loopDelayMs = 0;
// Probe the event loop continuously with a 100ms timer; the overshoot is the
// delay. Cheap (one timer) and always fresh.
const loopProbeStart = performance.now();
let lastTick = loopProbeStart;
setInterval(() => {
  const now = performance.now();
  loopDelayMs = Math.max(0, Math.round((now - lastTick - 100) * 10) / 10);
  lastTick = now;
}, 100).unref();

export function debugProcess(): DebugProcess {
  const mem = memoryUsage();
  return {
    process: {
      cpuPercent: cpuPercent(),
      rss: mem.rss,
      pid,
    },
    memory: {
      heapUsed: mem.heapUsed,
      heapTotal: mem.heapTotal,
      external: mem.external,
      arrayBuffers: mem.arrayBuffers ?? 0,
    },
    eventLoop: { delayMs: loopDelayMs },
    build: {
      bunVersion: typeof Bun !== "undefined" ? Bun.version : nodeVersion,
      nodeVersion,
      platform: platform(),
      arch: arch(),
      numCpu: cpus().length,
    },
    uptimeSeconds: Math.floor(processUptime()),
    now: new Date().toISOString(),
  };
}
