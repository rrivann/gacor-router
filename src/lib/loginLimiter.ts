// In-memory progressive lockout for dashboard login. Ported from 9router's
// pattern. Reset on process restart — that's fine, it's a defense against
// online brute-force, not offline hash cracking (see dashboardAuth for the
// bcrypt slow-hash that handles the offline case).

import type { Context } from "hono";

const MAX_FAILS_BEFORE_LOCK = 5;
// Escalating lockout so a brute-forcer can't just wait out a fixed window.
const LOCK_STEPS_MS = [30_000, 120_000, 600_000, 1_800_000]; // 30s, 2m, 10m, 30m
const FAIL_WINDOW_MS = 60 * 60 * 1000; // 1h since last fail → auto reset

interface Entry {
  fails: number;
  lockUntil: number;
  lockLevel: number;
  lastFailAt: number;
}

const attempts = new Map<string, Entry>();

function now(): number {
  return Date.now();
}

function getEntry(ip: string): Entry | null {
  const e = attempts.get(ip);
  if (!e) return null;
  // Auto reset if the fail window expired and no active lock — keeps the map
  // from growing forever with stale IPs.
  if (e.lastFailAt && now() - e.lastFailAt > FAIL_WINDOW_MS && (!e.lockUntil || now() >= e.lockUntil)) {
    attempts.delete(ip);
    return null;
  }
  return e;
}

export function checkLock(ip: string): { locked: false } | { locked: true; retryAfter: number } {
  const e = getEntry(ip);
  if (!e || !e.lockUntil) return { locked: false };
  const remaining = e.lockUntil - now();
  if (remaining <= 0) return { locked: false };
  return { locked: true, retryAfter: Math.ceil(remaining / 1000) };
}

export function recordFail(ip: string): { remainingBeforeLock: number } {
  const e = getEntry(ip) ?? { fails: 0, lockUntil: 0, lockLevel: 0, lastFailAt: 0 };
  e.fails += 1;
  e.lastFailAt = now();
  if (e.fails >= MAX_FAILS_BEFORE_LOCK) {
    const step = LOCK_STEPS_MS[Math.min(e.lockLevel, LOCK_STEPS_MS.length - 1)]!;
    e.lockUntil = now() + step;
    e.lockLevel += 1;
    e.fails = 0;
  }
  attempts.set(ip, e);
  return { remainingBeforeLock: Math.max(0, MAX_FAILS_BEFORE_LOCK - e.fails) };
}

export function recordSuccess(ip: string): void {
  attempts.delete(ip);
}

// Best-effort client IP. Behind a trusted reverse proxy the X-Forwarded-For
// first hop is authoritative; direct exposure falls back to a single bucket
// so a spoofed XFF rotation can't escape the limiter. Hono's Bun adapter
// currently doesn't surface the socket remote address, so this is the best
// we can do without pulling a `trust proxy` toggle in.
export function getClientIp(c: Context): string {
  if (process.env.TRUST_PROXY === "true") {
    const xff = c.req.header("x-forwarded-for");
    if (xff) return xff.split(",")[0]!.trim();
    const real = c.req.header("x-real-ip");
    if (real) return real.trim();
  }
  return "shared";
}

// Test hook — clear all lockout state.
export function _resetLoginLimiter(): void {
  attempts.clear();
}
