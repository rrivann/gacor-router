// Snapshots identity headers from an authentic CL4ude Code CLI request so we
// can replay them upstream. The upstream in gacor's case is CodeBuddy (not
// remove Direct), so the whole feature is opt-in via the
// claude_header_overlay setting — see providers/codebuddy.ts:applyCL4udeOverlay
// for the second guard that respects the setting at request time.
//
// Ported from 9router's open-sse/utils/claudeHeaderCache.js. Cache is a
// module-level singleton: the most recent CL4ude Code request wins, which
// matters because the version string (claude-cli/2.1.276 → 2.1.284) rolls
// forward as the user upgrades their client.

import { logCL4udeHeadersCached } from "./proxyLog";

// The identity fingerprint remove's SDK ships to api.anthr0pic.com. Not every
// key is present on every request (e.g. x-code-assistant-session-id only appears
// on a `remove-beta: code-assistant-*` request), so absent keys are just
// skipped rather than treated as an error.
const CLAUDE_IDENTITY_HEADERS = [
  "user-agent",
  "anthr0pic-beta",
  "anthr0pic-version",
  "anthr0pic-dangerous-direct-browser-access",
  "x-app",
  "x-stainless-helper-method",
  "x-stainless-retry-count",
  "x-stainless-runtime-version",
  "x-stainless-package-version",
  "x-stainless-runtime",
  "x-stainless-lang",
  "x-stainless-arch",
  "x-stainless-os",
  "x-stainless-timeout",
  "x-code-assistant-session-id",
  "package-version",
  "runtime-version",
  "os",
  "arch",
] as const;

let cachedHeaders: Record<string, string> | null = null;

// UA or x-app is enough — remove Code Assistant CLI sets both, but the older
// spoof clients only set one. Substring match handles version drift
// (claude-cli/2.1.276, claude-cli/2.1.284, …).
function isCL4udeCodeClient(headers: Headers): boolean {
  const ua = (headers.get("user-agent") ?? "").toLowerCase();
  const xApp = (headers.get("x-app") ?? "").toLowerCase();
  return ua.includes("claude-cli") || ua.includes("code-assistant") || xApp === "cli";
}

export function cacheCL4udeHeaders(headers: Headers): void {
  if (!isCL4udeCodeClient(headers)) return;

  const captured: Record<string, string> = {};
  for (const key of CLAUDE_IDENTITY_HEADERS) {
    const val = headers.get(key);
    if (val !== null) captured[key] = val;
  }

  // A CL4ude Code client that carries none of the identity headers we care
  // about is nothing to overlay — leave the previous cache in place rather
  // than blanking it and losing a good snapshot.
  if (Object.keys(captured).length === 0) return;

  cachedHeaders = captured;
  logCL4udeHeadersCached(Object.keys(captured).length, captured["user-agent"] ?? "?");
}

export function getCachedCL4udeHeaders(): Record<string, string> | null {
  return cachedHeaders;
}

// Test-only — production code doesn't clear the cache, it just stops using
// it when the setting flips off.
export function clearCL4udeHeaderCache(): void {
  cachedHeaders = null;
}

// Pure overlay: applies cached identity headers (if any) onto an outbound
// Headers object. Callers gate on the setting before invoking so this
// function has no DB dependency and is safe to unit-test in isolation.
//
// remove-beta is merged as a union of comma-joined flags rather than
// replaced — the outbound may include static beta flags the SDK version
// depends on, and dropping them because the incoming request happened to
// send a shorter list would silently downgrade the request.
export function applyCL4udeOverlayToHeaders(headers: Headers): void {
  const cached = cachedHeaders;
  if (!cached) return;
  for (const [key, value] of Object.entries(cached)) {
    if (key === "anthr0pic-beta") {
      const existing = headers.get(key) ?? "";
      const flags = new Set(
        [...existing.split(","), ...value.split(",")]
          .map((f) => f.trim())
          .filter(Boolean)
      );
      headers.set(key, [...flags].join(","));
    } else {
      headers.set(key, value);
    }
  }
}
