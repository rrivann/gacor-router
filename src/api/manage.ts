// Management API for the dashboard. All routes live under /api. A session
// gate (sessionAuth) protects them by default; requests from loopback bypass
// the gate the same way apiKeyAuth does for /v1/*, so the developer on their
// own machine keeps a friction-free experience. The auth routes themselves
// (/api/auth/*) are registered BEFORE the gate so login/status stay reachable
// without a cookie.

import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import {
  createAccount,
  deleteAccount,
  deleteSetting,
  getAccount,
  listAccounts,
  listAllAccounts,
  listSettings,
  setAccountStatus,
  setSetting,
  updateLabel,
} from "../db/accounts";
import { deriveIdentity, deriveLabel } from "../lib/label";
import {
  dashboardStats,
  getRequestLog,
  listRequestLogs,
  modelUsage,
  usageReport,
  type UsageRange,
} from "../db/logs";
import { errorResponse } from "../lib/http";
import {
  disableTunnel,
  enableTunnel,
  getTunnelStatus,
  regenerateShortId,
  setPublicUrlEnabled,
} from "../tunnel/manager";
import { fetchAndCacheUsage, UsageError } from "../lib/usage";
import { warmAccount, warmAll } from "../lib/warmup";
import { getAutoWarmConfig, setAutoWarmConfig } from "../lib/autowarm";
import {
  createChatSession,
  deleteChatSession,
  getChatSession,
  listChatSessions,
  updateChatSession,
} from "../db/chats";
import { debugProcess } from "../lib/debug";
import { env } from "../lib/env";
import {
  createContentFilter,
  deleteContentFilter,
  listContentFilters,
  updateContentFilter,
} from "../db/filters";
import { invalidateFilters } from "../lib/filters";
import {
  createApiKey,
  deleteApiKey,
  getApiKey,
  listApiKeys,
  updateApiKey,
} from "../db/apiKeys";
import { generateApiKeySecret, invalidateApiKeyCache } from "../lib/apiKeyAuth";
import { listVideoJobs, getVideoJob, deleteVideoJob } from "../db/videoJobs";
import { clearConsoleLogs, getConsoleLogs } from "../lib/consoleLog";
import { unlinkSync, existsSync } from "node:fs";
import {
  COOKIE_NAME,
  clearSession,
  currentRow,
  hasPassword,
  isLoopbackRequest,
  issueSession,
  sessionAuth,
  setPassword,
  verifyPassword,
  verifySessionCookie,
} from "../lib/dashboardAuth";
import { checkLock, getClientIp, recordFail, recordSuccess } from "../lib/loginLimiter";

export const manage = new Hono();

// ── Dashboard auth (registered FIRST so /api/auth/* is reachable without a
// session cookie — the gate below wraps everything else) ─────────────────

// Static build info. Read once from package.json at boot so the endpoint
// itself is a hot lookup — a fresh install adds a couple of KB to the
// server's resident set but no per-request I/O.
import pkg from "../../package.json" with { type: "json" };
const BUILD_VERSION = (pkg as { version?: string }).version ?? "0.0.0";

// Public — the sidebar polls this on mount to show the running version.
manage.get("/version", (c) => c.json({ version: BUILD_VERSION }));

// Report auth state so the SPA can decide whether to redirect to /login,
// show a "set a password" prompt, or render normally.
manage.get("/auth/status", async (c) => {
  const has = hasPassword();
  const loopback = isLoopbackRequest(c);
  // Loopback and no-password both count as effectively authenticated — the
  // gate would let them through anyway.
  let authenticated = !has || loopback;
  if (has && !loopback) {
    const token = getCookie(c, COOKIE_NAME);
    authenticated = await verifySessionCookie(token);
  }
  return c.json({ needsPassword: !has, authenticated, loopback });
});

// Verify password + issue the JWT cookie. Materialises the default password
// as a real row on first success so subsequent logins take the bcrypt path.
manage.post("/auth/login", async (c) => {
  const ip = getClientIp(c);
  const lock = checkLock(ip);
  if (lock.locked) {
    return errorResponse(
      429,
      "invalid_request_error",
      `too many failed attempts — retry in ${lock.retryAfter}s`
    );
  }

  let body: { password?: unknown };
  try { body = await c.req.json(); }
  catch { return errorResponse(400, "invalid_request_error", "invalid JSON body"); }
  const password = typeof body.password === "string" ? body.password : "";

  const result = await verifyPassword(password);
  if (!result.ok) {
    const { remainingBeforeLock } = recordFail(ip);
    return errorResponse(
      401,
      "invalid_request_error",
      `invalid password (${remainingBeforeLock} attempt(s) before lockout)`
    );
  }
  recordSuccess(ip);

  // If the row didn't exist yet and the default password matched, materialise
  // it now so we have a JWT secret to sign with. The session then rides on the
  // real row for the rest of its lifetime.
  if (result.usingDefault) await setPassword(password);
  const row = currentRow();
  if (!row) return errorResponse(500, "internal_error", "session row missing after setPassword");

  await issueSession(c, row.jwtSecret);
  return c.json({ ok: true, mustChangePassword: result.usingDefault });
});

manage.post("/auth/logout", (c) => {
  clearSession(c);
  return c.json({ ok: true });
});

// Change the password. Requires the current password even though the session
// gate already ran — defense in depth against a stolen cookie. Rotates the
// JWT secret so every other active session (there shouldn't be any, but…) is
// invalidated at the same time. The current caller's cookie is cleared too;
// they'll be redirected to /login by the SPA on the next fetch.
manage.post("/auth/change-password", async (c) => {
  let body: { currentPassword?: unknown; newPassword?: unknown };
  try { body = await c.req.json(); }
  catch { return errorResponse(400, "invalid_request_error", "invalid JSON body"); }

  const current = typeof body.currentPassword === "string" ? body.currentPassword : "";
  const next = typeof body.newPassword === "string" ? body.newPassword : "";
  if (next.length < 6) {
    return errorResponse(400, "invalid_request_error", "new password must be at least 6 characters", "newPassword");
  }
  const check = await verifyPassword(current);
  if (!check.ok) {
    return errorResponse(403, "invalid_request_error", "current password incorrect", "currentPassword");
  }
  await setPassword(next);
  clearSession(c);
  return c.json({ ok: true });
});

// Everything below this line requires a valid session (subject to the
// bypasses documented in dashboardAuth: no-password-yet and loopback).
manage.use("*", sessionAuth);

// ── Accounts ─────────────────────────────────────────────────────

manage.get("/accounts", (c) => {
  const provider = c.req.query("provider") || undefined;
  return c.json({ data: listAllAccounts(provider) });
});

manage.post("/accounts", async (c) => {
  let body: { provider?: unknown; label?: unknown; secret?: unknown; creds?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return errorResponse(400, "invalid_request_error", "invalid JSON body");
  }
  if (typeof body.provider !== "string" || body.provider.length === 0) {
    return errorResponse(400, "invalid_request_error", "`provider` must be a non-empty string", "provider");
  }
  const secret = typeof body.secret === "string" ? body.secret : "";
  const creds =
    typeof body.creds === "object" && body.creds !== null
      ? (body.creds as Record<string, string>)
      : undefined;
  if (secret.length === 0 && Object.keys(creds ?? {}).length === 0) {
    return errorResponse(400, "invalid_request_error", "either `secret` or `creds` is required");
  }

  // Dedup: reject a credential whose RT string, JWT identity (sub), or api_key
  // already sits under the same provider. Two credentials that map to the same
  // upstream account (matching sub, matching api_key, or literal RT reuse)
  // would double-count quota if pooled together.
  const existing = listAccounts(body.provider);
  const newRt = creds?.refresh_token?.trim();
  const newApiKey = creds?.api_key?.trim();
  const newSub = deriveIdentity(creds);
  for (const row of existing) {
    const rowRt = row.creds?.refresh_token?.trim();
    if (newRt && rowRt && rowRt === newRt) {
      return errorResponse(409, "invalid_request_error", `refresh_token already used by account #${row.id}`, "duplicate_account");
    }
    const rowApiKey = row.creds?.api_key?.trim();
    if (newApiKey && rowApiKey && rowApiKey === newApiKey) {
      return errorResponse(409, "invalid_request_error", `api_key already used by account #${row.id}`, "duplicate_account");
    }
    const rowSub = deriveIdentity(row.creds);
    if (newSub && rowSub && rowSub === newSub) {
      return errorResponse(409, "invalid_request_error", `same upstream identity as account #${row.id} (sub match)`, "duplicate_account");
    }
  }

  const userLabel = typeof body.label === "string" && body.label.length > 0 ? body.label : undefined;
  // JWT-derived default when the user didn't pick one — visible immediately
  // if creds already carry an AT; otherwise warmup will fill it in after the
  // first exchange.
  const initialLabel = userLabel ?? deriveLabel(creds) ?? undefined;
  const id = createAccount({
    provider: body.provider,
    label: initialLabel,
    secret,
    creds,
  });
  // Warm the fresh account inline (enowx pattern): it enters the pool with a
  // verified status and a fresh credit snapshot. Best-effort — a probe
  // failure doesn't fail the creation.
  const warmup = await warmAccount(id).catch(() => null);
  return c.json({ success: true, id, warmup }, 201);
});

// Verbatim credentials — the UI reveal button calls this.
manage.get("/accounts/:id/reveal", (c) => {
  const id = Number(c.req.param("id"));
  const row = getAccount(id);
  if (!row) return errorResponse(404, "invalid_request_error", `account #${id} not found`);
  return c.json({ id: row.id, secret: row.secret, creds: row.creds ?? {} });
});

manage.post("/accounts/:id/status", async (c) => {
  const id = Number(c.req.param("id"));
  let body: { status?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return errorResponse(400, "invalid_request_error", "invalid JSON body");
  }
  if (body.status !== "active" && body.status !== "exhausted" && body.status !== "banned") {
    return errorResponse(400, "invalid_request_error", "`status` must be active | exhausted | banned", "status");
  }
  if (!getAccount(id)) return errorResponse(404, "invalid_request_error", `account #${id} not found`);
  setAccountStatus(id, body.status);
  return c.json({ success: true, id, status: body.status });
});

manage.delete("/accounts/:id", (c) => {
  const id = Number(c.req.param("id"));
  if (!deleteAccount(id)) {
    return errorResponse(404, "invalid_request_error", `account #${id} not found`);
  }
  return c.json({ success: true, id });
});

// Bulk delete — dashboard toolbar sends the visible/selected id list here so
// nuking 100 codebuddy rows doesn't need 100 sequential DELETEs. Missing rows
// are silently counted as failed instead of aborting the batch.
manage.post("/accounts/delete-bulk", async (c) => {
  const body = (await c.req.json().catch(() => null)) as { ids?: unknown } | null;
  if (!body || !Array.isArray(body.ids)) {
    return errorResponse(400, "invalid_request_error", "`ids` must be an array of account ids", "ids");
  }
  const ids = body.ids.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  if (ids.length === 0) {
    return errorResponse(400, "invalid_request_error", "`ids` must contain at least one id", "ids");
  }
  let deleted = 0;
  const failed: number[] = [];
  for (const id of ids) {
    if (deleteAccount(id)) deleted++;
    else failed.push(id);
  }
  return c.json({ success: true, deleted, failed });
});

// ── Request logs ─────────────────────────────────────────────────

manage.get("/stats/requests", (c) => {
  const limit = Math.min(Math.max(Number(c.req.query("limit")) || 100, 1), 500);
  const offset = Math.max(Number(c.req.query("offset")) || 0, 0);
  const provider = c.req.query("provider") || undefined;
  return c.json({ data: listRequestLogs({ limit, offset, provider }) });
});

manage.get("/stats/requests/:id", (c) => {
  const id = Number(c.req.param("id"));
  const row = getRequestLog(id);
  if (!row) return errorResponse(404, "invalid_request_error", `request log #${id} not found`);
  return c.json({ data: row });
});

manage.get("/stats/dashboard", (c) => c.json(dashboardStats()));

manage.get("/stats/models", (c) => c.json({ data: modelUsage() }));

// Token usage for the dashboard card: totals + time buckets + per-model,
// scoped to a rolling range (1d hourly, 7d/30d daily, all monthly).
manage.get("/stats/usage", (c) => {
  const q = c.req.query("range") ?? "1d";
  const range: UsageRange = q === "7d" || q === "30d" || q === "all" ? q : "1d";
  return c.json(usageReport(range));
});

// ── Console logs ─────────────────────────────────────────────────
// Ring buffer of the router process's own console output. The dashboard
// /console-log page reads this on mount and then follows the `console_log`
// WS event stream for live tail. DELETE wipes the buffer.

manage.get("/console-logs", (c) => c.json({ data: getConsoleLogs() }));

manage.delete("/console-logs", (c) => {
  clearConsoleLogs();
  return c.json({ success: true });
});

// ── Settings ─────────────────────────────────────────────────────

manage.get("/settings", (c) => c.json({ data: listSettings() }));

manage.put("/settings", async (c) => {
  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return errorResponse(400, "invalid_request_error", "invalid JSON body");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return errorResponse(400, "invalid_request_error", "body must be a JSON object of key → value");
  }
  for (const [key, value] of Object.entries(body)) {
    if (typeof value !== "string") {
      return errorResponse(400, "invalid_request_error", `setting "${key}" must be a string`, key);
    }
  }
  for (const [key, value] of Object.entries(body)) setSetting(key, value as string);
  return c.json({ success: true, data: listSettings() });
});

manage.delete("/settings/:key", (c) => {
  const key = c.req.param("key");
  if (!deleteSetting(key)) {
    return errorResponse(404, "invalid_request_error", `setting "${key}" not found`);
  }
  return c.json({ success: true, key });
});

// ── Tunnel (Cloudflare quick tunnel) ─────────────────────────────
// Exposes the local router on a public https://*.trycloudflare.com URL.
// Enable/disable are idempotent; status is safe to poll.

manage.get("/tunnel/status", (c) => c.json(getTunnelStatus()));

manage.post("/tunnel/enable", async (c) => {
  const result = await enableTunnel(env.port);
  if (!result.success) {
    return errorResponse(502, "internal_error", result.error ?? "tunnel enable failed");
  }
  return c.json(result);
});

manage.post("/tunnel/disable", (c) => c.json(disableTunnel()));

// Toggle the abc-tunnel.us stable URL feature on/off. Doesn't restart the
// tunnel — the next status read reflects it (publicUrl null when off).
manage.put("/tunnel/public-url", async (c) => {
  const body = (await c.req.json().catch(() => null)) as { enabled?: unknown } | null;
  if (!body || typeof body.enabled !== "boolean") {
    return errorResponse(400, "invalid_request_error", "`enabled` must be a boolean", "enabled");
  }
  setPublicUrlEnabled(body.enabled);
  return c.json({ success: true, enabled: body.enabled });
});

// Explicit reset: mint a fresh shortId. Existing stable URL becomes invalid;
// the next enable registers the new one. Use this if the current shortId
// might have been hijacked on the unauthenticated worker.
manage.post("/tunnel/regenerate-short-id", (c) => {
  const shortId = regenerateShortId();
  return c.json({ success: true, shortId });
});

// ── Account usage (credit snapshots) ─────────────────────────────

manage.get("/accounts/:id/usage", (c) => {
  const id = Number(c.req.param("id"));
  const row = getAccount(id);
  if (!row) return errorResponse(404, "invalid_request_error", `account #${id} not found`);
  return c.json({ data: row.usageJson ?? null, fetchedAt: row.usageAt ?? null });
});

manage.post("/accounts/:id/usage/refresh", async (c) => {
  const id = Number(c.req.param("id"));
  try {
    const usage = await fetchAndCacheUsage(id);
    return c.json({ data: usage });
  } catch (err) {
    if (err instanceof UsageError) {
      return errorResponse(err.status, "internal_error", err.message);
    }
    return errorResponse(502, "internal_error", err instanceof Error ? err.message : String(err));
  }
});

// ── Warmup ───────────────────────────────────────────────────────
// Probe an account with a real (cheap) request to verify it's alive, update
// its pool status, and refresh the credit snapshot.

manage.post("/accounts/:id/warmup", async (c) => {
  const id = Number(c.req.param("id"));
  const result = await warmAccount(id);
  if (result.outcome === "error" && result.error?.includes("not found")) {
    return errorResponse(404, "invalid_request_error", result.error);
  }
  return c.json(result);
});

manage.post("/accounts/warmup-all", async (c) => {
  const provider = c.req.query("provider");
  if (!provider) {
    return errorResponse(400, "invalid_request_error", "`provider` query param is required", "provider");
  }
  const statuses = c.req.query("statuses")?.split(",").filter(Boolean);
  const result = await warmAll(provider, { statuses });
  return c.json({ success: true, ...result });
});

// Per-provider auto-warmup config (scheduler reads it every tick).
manage.get("/providers/:name/auto-warmup", (c) => {
  return c.json(getAutoWarmConfig(c.req.param("name")));
});

manage.put("/providers/:name/auto-warmup", async (c) => {
  const name = c.req.param("name");
  let body: {
    enabled?: unknown;
    intervalMinutes?: unknown;
    statuses?: unknown;
    concurrency?: unknown;
    skipRecentlyWarmed?: unknown;
  };
  try {
    body = await c.req.json();
  } catch {
    return errorResponse(400, "invalid_request_error", "invalid JSON body");
  }
  const cfg = getAutoWarmConfig(name);
  if (typeof body.enabled === "boolean") cfg.enabled = body.enabled;
  if (typeof body.intervalMinutes === "number" && body.intervalMinutes > 0) {
    cfg.intervalMinutes = body.intervalMinutes;
  }
  if (Array.isArray(body.statuses) && body.statuses.every((s) => typeof s === "string")) {
    cfg.statuses = body.statuses as string[];
  }
  if (typeof body.concurrency === "number" && body.concurrency > 0) {
    cfg.concurrency = Math.min(body.concurrency, 16);
  }
  if (typeof body.skipRecentlyWarmed === "boolean") {
    cfg.skipRecentlyWarmed = body.skipRecentlyWarmed;
  }
  setAutoWarmConfig(name, cfg);
  return c.json(cfg);
});

// ── AI Chat sessions ─────────────────────────────────────────────
// Persistence for the dashboard's chat playground. `messages` is an opaque
// JSON blob owned by the frontend.

manage.get("/chat/sessions", (c) => c.json({ sessions: listChatSessions() }));

manage.get("/chat/sessions/:id", (c) => {
  const id = Number(c.req.param("id"));
  const row = getChatSession(id);
  if (!row) return errorResponse(404, "invalid_request_error", `session #${id} not found`);
  return c.json(row);
});

manage.post("/chat/sessions", async (c) => {
  let body: { title?: unknown; model?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return errorResponse(400, "invalid_request_error", "invalid JSON body");
  }
  const id = createChatSession({
    title: typeof body.title === "string" ? body.title : undefined,
    model: typeof body.model === "string" ? body.model : undefined,
  });
  return c.json({ id }, 201);
});

manage.put("/chat/sessions/:id", async (c) => {
  const id = Number(c.req.param("id"));
  let body: { title?: unknown; model?: unknown; messages?: unknown; msgCount?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return errorResponse(400, "invalid_request_error", "invalid JSON body");
  }
  const ok = updateChatSession(id, {
    title: typeof body.title === "string" ? body.title : undefined,
    model: typeof body.model === "string" ? body.model : undefined,
    messages: typeof body.messages === "string" ? body.messages : undefined,
    msgCount: typeof body.msgCount === "number" ? body.msgCount : undefined,
  });
  if (!ok) return errorResponse(404, "invalid_request_error", `session #${id} not found`);
  return c.json({ ok: true });
});

manage.delete("/chat/sessions/:id", (c) => {
  const id = Number(c.req.param("id"));
  if (!deleteChatSession(id)) {
    return errorResponse(404, "invalid_request_error", `session #${id} not found`);
  }
  return c.json({ ok: true });
});

// ── Content filters ──────────────────────────────────────────────
// enowx-inspired: pattern→replacement rules applied to outbound message text
// before the request reaches the provider. Rows expose all fields to the UI
// so a rule can be toggled/reordered without a re-add.

manage.get("/filters", (c) => c.json({ data: listContentFilters() }));

// Empty array = global (same as null). Any other array must contain non-empty
// strings, deduped. Anything else fails.
function normalizeScope(v: unknown): { ok: true; value: string[] | null } | { ok: false; err: string } {
  if (v === null || v === undefined) return { ok: true, value: null };
  if (!Array.isArray(v)) return { ok: false, err: "`providerScope` must be an array of strings or null" };
  const cleaned: string[] = [];
  for (const item of v) {
    if (typeof item !== "string") return { ok: false, err: "`providerScope` entries must be strings" };
    const s = item.trim();
    if (s.length === 0) continue;
    if (!cleaned.includes(s)) cleaned.push(s);
  }
  return { ok: true, value: cleaned.length === 0 ? null : cleaned };
}

manage.post("/filters", async (c) => {
  let body: {
    pattern?: unknown;
    replacement?: unknown;
    isRegex?: unknown;
    isActive?: unknown;
    sort?: unknown;
    providerScope?: unknown;
  };
  try {
    body = await c.req.json();
  } catch {
    return errorResponse(400, "invalid_request_error", "invalid JSON body");
  }
  if (typeof body.pattern !== "string" || body.pattern.length === 0) {
    return errorResponse(400, "invalid_request_error", "`pattern` must be a non-empty string", "pattern");
  }
  // Validate regex at write time — better to reject a bad rule than silently
  // drop it later in the engine.
  if (body.isRegex === true) {
    try {
      new RegExp(body.pattern);
    } catch (e) {
      return errorResponse(400, "invalid_request_error", `invalid regex: ${e instanceof Error ? e.message : String(e)}`, "pattern");
    }
  }
  const scope = normalizeScope(body.providerScope);
  if (!scope.ok) return errorResponse(400, "invalid_request_error", scope.err, "providerScope");
  const id = createContentFilter({
    pattern: body.pattern,
    replacement: typeof body.replacement === "string" ? body.replacement : "",
    isRegex: body.isRegex === true,
    isActive: body.isActive !== false,
    sort: typeof body.sort === "number" ? body.sort : 0,
    providerScope: scope.value,
  });
  invalidateFilters();
  return c.json({ id }, 201);
});

manage.patch("/filters/:id", async (c) => {
  const id = Number(c.req.param("id"));
  let body: {
    pattern?: unknown;
    replacement?: unknown;
    isRegex?: unknown;
    isActive?: unknown;
    sort?: unknown;
    providerScope?: unknown;
  };
  try {
    body = await c.req.json();
  } catch {
    return errorResponse(400, "invalid_request_error", "invalid JSON body");
  }
  const patch: {
    pattern?: string;
    replacement?: string;
    isRegex?: boolean;
    isActive?: boolean;
    sort?: number;
    providerScope?: string[] | null;
  } = {};
  if (typeof body.pattern === "string") patch.pattern = body.pattern;
  if (typeof body.replacement === "string") patch.replacement = body.replacement;
  if (typeof body.isRegex === "boolean") patch.isRegex = body.isRegex;
  if (typeof body.isActive === "boolean") patch.isActive = body.isActive;
  if (typeof body.sort === "number") patch.sort = body.sort;
  if ("providerScope" in body) {
    const scope = normalizeScope(body.providerScope);
    if (!scope.ok) return errorResponse(400, "invalid_request_error", scope.err, "providerScope");
    patch.providerScope = scope.value;
  }
  // Re-validate regex against the effective pattern.
  const effectivePattern = typeof patch.pattern === "string" ? patch.pattern : undefined;
  const effectiveRegex = typeof patch.isRegex === "boolean" ? patch.isRegex : undefined;
  if (effectiveRegex === true && typeof effectivePattern === "string") {
    try {
      new RegExp(effectivePattern);
    } catch (e) {
      return errorResponse(400, "invalid_request_error", `invalid regex: ${e instanceof Error ? e.message : String(e)}`, "pattern");
    }
  }
  const ok = updateContentFilter(id, patch);
  if (!ok) return errorResponse(404, "invalid_request_error", `filter #${id} not found`);
  invalidateFilters();
  return c.json({ ok: true });
});

manage.delete("/filters/:id", (c) => {
  const id = Number(c.req.param("id"));
  if (!deleteContentFilter(id)) return errorResponse(404, "invalid_request_error", `filter #${id} not found`);
  invalidateFilters();
  return c.json({ ok: true });
});

// ── API keys ─────────────────────────────────────────────────────
// CRUD for the client-facing tokens that /v1/* checks against. Secrets are
// stored plaintext (single-user local install), so list/get return them as-is
// for the dashboard's Eye toggle.

// Normalize a JSON scope array from the wire: null / [] → null, else a
// deduped list of non-empty strings. Rejects anything else with a message.
function normalizeStringArrayScope(input: unknown, field: string):
  | { ok: true; value: string[] | null }
  | { ok: false; err: string } {
  if (input === null || input === undefined) return { ok: true, value: null };
  if (!Array.isArray(input)) return { ok: false, err: `${field} must be an array or null` };
  const out: string[] = [];
  for (const item of input) {
    if (typeof item !== "string") return { ok: false, err: `${field} entries must be strings` };
    const s = item.trim();
    if (s.length === 0) continue;
    if (!out.includes(s)) out.push(s);
  }
  return { ok: true, value: out.length === 0 ? null : out };
}

manage.get("/keys", (c) => {
  return c.json({ data: listApiKeys() });
});

manage.post("/keys", async (c) => {
  let body: {
    label?: unknown;
    tokenLimit?: unknown;
    maxConcurrent?: unknown;
    expiresAt?: unknown;
    allowedModels?: unknown;
    allowedProviders?: unknown;
  };
  try {
    body = await c.req.json();
  } catch {
    return errorResponse(400, "invalid_request_error", "invalid JSON body");
  }
  const label = typeof body.label === "string" ? body.label.trim() : "";
  const tokenLimit = typeof body.tokenLimit === "number" && body.tokenLimit >= 0 ? Math.floor(body.tokenLimit) : 0;
  const maxConcurrent =
    typeof body.maxConcurrent === "number" && body.maxConcurrent >= 0 ? Math.floor(body.maxConcurrent) : 0;

  let expiresAt: Date | null = null;
  if (body.expiresAt != null) {
    const t = typeof body.expiresAt === "number" ? body.expiresAt : Date.parse(String(body.expiresAt));
    if (Number.isFinite(t)) expiresAt = new Date(t);
    else return errorResponse(400, "invalid_request_error", "expiresAt must be a unix ms or ISO date", "expiresAt");
  }

  const models = normalizeStringArrayScope(body.allowedModels, "allowedModels");
  if (!models.ok) return errorResponse(400, "invalid_request_error", models.err, "allowedModels");
  const providers = normalizeStringArrayScope(body.allowedProviders, "allowedProviders");
  if (!providers.ok) return errorResponse(400, "invalid_request_error", providers.err, "allowedProviders");

  const secret = generateApiKeySecret();
  const id = createApiKey({
    label,
    secret,
    tokenLimit,
    maxConcurrent,
    expiresAt,
    allowedModels: models.value,
    allowedProviders: providers.value,
  });
  invalidateApiKeyCache();
  return c.json({ id, secret });
});

manage.patch("/keys/:id", async (c) => {
  const id = Number(c.req.param("id"));
  if (!getApiKey(id)) return errorResponse(404, "invalid_request_error", `key #${id} not found`);

  let body: {
    label?: unknown;
    enabled?: unknown;
    tokenLimit?: unknown;
    maxConcurrent?: unknown;
    expiresAt?: unknown;
    allowedModels?: unknown;
    allowedProviders?: unknown;
  };
  try {
    body = await c.req.json();
  } catch {
    return errorResponse(400, "invalid_request_error", "invalid JSON body");
  }

  const patch: Parameters<typeof updateApiKey>[1] = {};
  if (typeof body.label === "string") patch.label = body.label.trim();
  if (typeof body.enabled === "boolean") patch.enabled = body.enabled;
  if (typeof body.tokenLimit === "number" && body.tokenLimit >= 0) patch.tokenLimit = Math.floor(body.tokenLimit);
  if (typeof body.maxConcurrent === "number" && body.maxConcurrent >= 0)
    patch.maxConcurrent = Math.floor(body.maxConcurrent);
  if ("expiresAt" in body) {
    if (body.expiresAt === null) patch.expiresAt = null;
    else {
      const t = typeof body.expiresAt === "number" ? body.expiresAt : Date.parse(String(body.expiresAt));
      if (!Number.isFinite(t))
        return errorResponse(400, "invalid_request_error", "expiresAt must be a unix ms or ISO date", "expiresAt");
      patch.expiresAt = new Date(t);
    }
  }
  if ("allowedModels" in body) {
    const s = normalizeStringArrayScope(body.allowedModels, "allowedModels");
    if (!s.ok) return errorResponse(400, "invalid_request_error", s.err, "allowedModels");
    patch.allowedModels = s.value;
  }
  if ("allowedProviders" in body) {
    const s = normalizeStringArrayScope(body.allowedProviders, "allowedProviders");
    if (!s.ok) return errorResponse(400, "invalid_request_error", s.err, "allowedProviders");
    patch.allowedProviders = s.value;
  }

  const ok = updateApiKey(id, patch);
  invalidateApiKeyCache();
  return c.json({ ok });
});

manage.delete("/keys/:id", (c) => {
  const id = Number(c.req.param("id"));
  if (!deleteApiKey(id)) return errorResponse(404, "invalid_request_error", `key #${id} not found`);
  invalidateApiKeyCache();
  return c.json({ ok: true });
});

// ── Video jobs (dashboard) ───────────────────────────────────────
// Read-only listing + detail + delete. Submission goes through /v1/videos/*
// (client API) instead — the dashboard would use that too.

manage.get("/videos", (c) => {
  const status = c.req.query("status");
  const rows = listVideoJobs({ status: status || undefined, limit: 200 });
  return c.json({ data: rows });
});

manage.get("/videos/:id", (c) => {
  const id = Number(c.req.param("id"));
  const row = getVideoJob(id);
  if (!row) return errorResponse(404, "invalid_request_error", `video job #${id} not found`);
  return c.json({ data: row });
});

manage.delete("/videos/:id", (c) => {
  const id = Number(c.req.param("id"));
  const row = deleteVideoJob(id);
  if (!row) return errorResponse(404, "invalid_request_error", `video job #${id} not found`);
  // Best-effort file cleanup — an already-missing file is fine.
  if (row.filePath && existsSync(row.filePath)) {
    try { unlinkSync(row.filePath); } catch {}
  }
  return c.json({ ok: true });
});

// ── Process debug ────────────────────────────────────────────────
// Self-diagnostics for the dashboard debug popover: CPU% (sampled between
// polls), RSS/heap, event-loop delay, build/platform info, uptime.
manage.get("/debug/process", (c) => c.json(debugProcess()));
