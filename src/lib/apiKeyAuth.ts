// API-key middleware for /v1/*. Extracts the token from four sources
// (Authorization Bearer, x-api-key, x-goog-api-key, ?key=), looks it up in
// the api_keys table, and enforces enabled/expiry/quota/concurrency. Skips
// auth in two safe-by-default cases so the local UX stays frictionless:
//   1. Open-gateway — the table is empty (fresh install).
//   2. Loopback   — the request came from 127.0.0.1 or ::1 (dashboard,
//                   curl on the host) and the router is bound to loopback.
//
// The matched key is stashed on the request context as "apiKey" so the
// logging tap and downstream scope checks can read it without another lookup.

import type { MiddlewareHandler } from "hono";
import { randomBytes } from "node:crypto";
import { countApiKeys, getApiKeyBySecret, touchApiKeyLastUsed, type ApiKeyRow } from "../db/apiKeys";
import { errorResponse } from "./http";

// Cached count (few-second TTL) so the open-gateway check doesn't hit sqlite
// per request. Invalidated by the management API after add/delete.
let cachedCount: { n: number; expiresAt: number } | null = null;
function keyCount(): number {
  const now = Date.now();
  if (cachedCount && cachedCount.expiresAt > now) return cachedCount.n;
  const n = countApiKeys();
  cachedCount = { n, expiresAt: now + 5_000 };
  return n;
}
export function invalidateApiKeyCache(): void {
  cachedCount = null;
  secretCache.clear();
}

// Cached secret → row (few-second TTL). Miss on unknown-secret is *not*
// cached, so revoking-then-reusing a key can't be tricked by stale positives.
const secretCache = new Map<string, { row: ApiKeyRow; expiresAt: number }>();
function lookup(secret: string): ApiKeyRow | undefined {
  const now = Date.now();
  const hit = secretCache.get(secret);
  if (hit && hit.expiresAt > now) return hit.row;
  const row = getApiKeyBySecret(secret);
  if (row) secretCache.set(secret, { row, expiresAt: now + 5_000 });
  return row;
}

// In-flight counter per key for concurrency enforcement. Cleared on release.
const inflight = new Map<number, number>();
function acquire(id: number, max: number): boolean {
  if (max <= 0) return true;
  const cur = inflight.get(id) ?? 0;
  if (cur >= max) return false;
  inflight.set(id, cur + 1);
  return true;
}
function release(id: number): void {
  const cur = inflight.get(id) ?? 0;
  if (cur <= 1) inflight.delete(id);
  else inflight.set(id, cur - 1);
}

// Extract from the four common places, in priority order. Returns null if
// nothing looks token-shaped.
export function extractToken(req: {
  header: (n: string) => string | undefined;
  url: string;
}): string | null {
  const auth = req.header("authorization") ?? req.header("Authorization");
  if (auth) {
    const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
    if (m && m[1]) return m[1].trim();
  }
  const xApi = req.header("x-api-key");
  if (xApi) return xApi.trim();
  const xGoog = req.header("x-goog-api-key");
  if (xGoog) return xGoog.trim();
  try {
    const u = new URL(req.url);
    const q = u.searchParams.get("key") ?? u.searchParams.get("api_key");
    if (q) return q.trim();
  } catch {
    // Non-absolute URL — Hono usually passes full URL, but fall through if not.
  }
  return null;
}

function isLoopback(host: string | undefined): boolean {
  if (!host) return false;
  return host === "127.0.0.1" || host === "::1" || host.startsWith("127.0.0.1:") || host === "localhost" || host.startsWith("localhost:");
}

// A request is "local" when the router is bound to loopback AND the Host
// header is loopback-shaped. The env is re-read each call so tests (and any
// future runtime host change) don't get pinned to what env.ts saw at import.
function isLocalRequest(c: Parameters<MiddlewareHandler>[0]): boolean {
  const bound = process.env.HOST ?? "127.0.0.1";
  if (bound !== "127.0.0.1" && bound !== "::1" && bound !== "localhost") return false;
  const host = c.req.header("host");
  return isLoopback(host);
}

export const apiKeyAuth: MiddlewareHandler = async (c, next) => {
  // Open-gateway: fresh install with no keys yet — skip auth so first-run
  // works out of the box (dashboard + curl). The moment a key exists, this
  // branch closes.
  if (keyCount() === 0) {
    await next();
    return;
  }

  // Loopback bypass: the router is bound to loopback and this request came
  // from loopback → it's the local user, no key required.
  if (isLocalRequest(c)) {
    await next();
    return;
  }

  const token = extractToken({ header: (n) => c.req.header(n), url: c.req.url });
  if (!token) {
    return errorResponse(401, "invalid_request_error", "missing API key (Authorization: Bearer …)");
  }

  const key = lookup(token);
  if (!key) {
    return errorResponse(401, "invalid_request_error", "invalid API key");
  }
  if (!key.enabled) {
    return errorResponse(403, "invalid_request_error", "API key is disabled");
  }
  if (key.expiresAt && key.expiresAt.getTime() < Date.now()) {
    return errorResponse(403, "invalid_request_error", "API key expired");
  }
  if (key.tokenLimit > 0 && key.tokensUsed >= key.tokenLimit) {
    return errorResponse(403, "invalid_request_error", "API key token quota exhausted");
  }
  if (!acquire(key.id, key.maxConcurrent)) {
    return errorResponse(429, "invalid_request_error", "API key concurrency limit reached");
  }

  c.set("apiKey", key);
  touchApiKeyLastUsed(key.id);

  try {
    await next();
  } finally {
    release(key.id);
  }
};

// Scope enforcement helper — called after resolveModel() so we know both
// provider and model. Returns null on OK, an error Response on refusal.
export function enforceKeyScope(
  key: ApiKeyRow | undefined,
  providerName: string,
  modelId: string
): Response | null {
  if (!key) return null;
  if (key.allowedProviders && key.allowedProviders.length > 0 && !key.allowedProviders.includes(providerName)) {
    return errorResponse(403, "invalid_request_error", `API key not allowed for provider "${providerName}"`);
  }
  if (key.allowedModels && key.allowedModels.length > 0) {
    // Accept either the bare model ("claude-opus-5") or the full route
    // ("codebuddy/claude-opus-5"), whichever the operator entered.
    const qualified = `${providerName}/${modelId}`;
    if (!key.allowedModels.includes(modelId) && !key.allowedModels.includes(qualified)) {
      return errorResponse(403, "invalid_request_error", `API key not allowed for model "${modelId}"`);
    }
  }
  return null;
}

// Utility for the management API. Prefix "gcr-" so the shape is
// self-describing; 24 random bytes = 48 hex chars gives 192 bits of entropy.
export function generateApiKeySecret(): string {
  return "gcr-" + randomBytes(24).toString("hex");
}
