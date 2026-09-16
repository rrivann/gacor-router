// Dashboard auth: bcrypt password + JWT session cookie for the management
// surface (/api/*). Separate from apiKeyAuth (/v1/*) which stays untouched
// — API keys are for machine clients, this is for the browser.
//
// Behaviour mirrors apiKeyAuth so the mental model stays consistent:
//   1. No password configured yet → skip the gate (fresh install / bootstrap).
//   2. Request came from loopback AND HOST is bound to loopback → skip
//      (developer on their own machine, dashboard has no friction).
//   3. Otherwise a valid session cookie is required.
//
// The JWT secret is minted on setPassword() and rotated on every password
// change, so an old cookie stops verifying the moment the password moves.

import type { Context, MiddlewareHandler } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { sign, verify } from "hono/jwt";
import { randomBytes } from "node:crypto";
import { desc, eq } from "drizzle-orm";
import { db } from "../db";
import { dashboardAuth } from "../db/schema";
import { errorResponse } from "./http";

export const COOKIE_NAME = "gacor_session";
const SESSION_MAX_AGE = 60 * 60 * 24 * 7; // 7 days
const BCRYPT_COST = 10;

// Default password only used when the row is empty. Kept intentionally weak
// so first-run installers know exactly what to type — the login handler
// materialises the row and forces a change on first non-loopback login.
export const DEFAULT_PASSWORD = "123456";

export interface DashboardAuthRow {
  id: number;
  passwordHash: string;
  jwtSecret: string;
  createdAt: Date;
  updatedAt: Date;
}

// 5-second cache to keep the "does auth exist" check off the sqlite hot path.
// Invalidated on every mutation (setPassword) — same pattern as apiKeyAuth.
let cachedRow: { row: DashboardAuthRow | null; expiresAt: number } | null = null;

function loadRow(): DashboardAuthRow | null {
  const now = Date.now();
  if (cachedRow && cachedRow.expiresAt > now) return cachedRow.row;
  // Table is a singleton, but autoincrement means the row's id isn't
  // predictable across test resets — grab the latest instead of hard-coding 1.
  const row = (db.select().from(dashboardAuth).orderBy(desc(dashboardAuth.id)).limit(1).get() as DashboardAuthRow | undefined) ?? null;
  cachedRow = { row, expiresAt: now + 5_000 };
  return row;
}

export function invalidateDashboardAuthCache(): void {
  cachedRow = null;
}

export function hasPassword(): boolean {
  return loadRow() !== null;
}

// Verifies against the stored hash. When no row exists yet, compares against
// the default password so first login works — caller then calls setPassword
// to materialise the row + mint a JWT secret.
export async function verifyPassword(pw: string): Promise<{ ok: boolean; usingDefault: boolean }> {
  if (typeof pw !== "string" || pw.length === 0) return { ok: false, usingDefault: false };
  const row = loadRow();
  if (!row) {
    return { ok: pw === DEFAULT_PASSWORD, usingDefault: true };
  }
  const ok = await Bun.password.verify(pw, row.passwordHash);
  return { ok, usingDefault: false };
}

// Hash + mint a fresh JWT secret. Called on first login (materialising the
// default) and on every subsequent change. Rotating the secret is how we
// invalidate every existing session in one shot.
export async function setPassword(pw: string): Promise<void> {
  if (typeof pw !== "string" || pw.length < 6) {
    throw new Error("password must be at least 6 characters");
  }
  const passwordHash = await Bun.password.hash(pw, { algorithm: "bcrypt", cost: BCRYPT_COST });
  const jwtSecret = randomBytes(32).toString("hex");
  const existing = loadRow();
  if (existing) {
    db.update(dashboardAuth)
      .set({ passwordHash, jwtSecret, updatedAt: new Date() })
      .where(eq(dashboardAuth.id, existing.id))
      .run();
  } else {
    // Fresh row — sqlite autoincrement picks the next id automatically.
    db.insert(dashboardAuth).values({ passwordHash, jwtSecret }).run();
  }
  invalidateDashboardAuthCache();
}

// Loopback bypass: identical semantics to apiKeyAuth.isLocalRequest so the
// two gates agree on what "the local user" means. Env is re-read live so
// tests + runtime host changes work.
export function isLoopbackRequest(c: Context): boolean {
  const bound = process.env.HOST ?? "127.0.0.1";
  if (bound !== "127.0.0.1" && bound !== "::1" && bound !== "localhost") return false;
  const host = c.req.header("host");
  if (!host) return false;
  return (
    host === "127.0.0.1" ||
    host === "::1" ||
    host === "localhost" ||
    host.startsWith("127.0.0.1:") ||
    host.startsWith("localhost:")
  );
}

// Issue a signed JWT cookie. `secure` flips on behind an HTTPS proxy
// (Cloudflare tunnel forwards X-Forwarded-Proto). httpOnly + SameSite=Lax
// gives CSRF-safe, XSS-hardened session storage.
export async function issueSession(c: Context, jwtSecret: string): Promise<void> {
  const exp = Math.floor(Date.now() / 1000) + SESSION_MAX_AGE;
  const token = await sign({ sub: "dashboard", exp }, jwtSecret, "HS256");
  const secure = c.req.header("x-forwarded-proto") === "https";
  setCookie(c, COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "Lax",
    path: "/",
    maxAge: SESSION_MAX_AGE,
    secure,
  });
}

export function clearSession(c: Context): void {
  deleteCookie(c, COOKIE_NAME, { path: "/" });
}

// Returns the row so callers can also inspect the JWT secret (for auth/status
// which needs to verify the cookie without going through the middleware).
export function currentRow(): DashboardAuthRow | null {
  return loadRow();
}

// Verify a cookie against the current row's secret. Returns true only when
// both the row exists AND the cookie's signature matches AND the token isn't
// expired. Any failure (including malformed cookie) returns false silently.
export async function verifySessionCookie(token: string | undefined): Promise<boolean> {
  if (!token) return false;
  const row = loadRow();
  if (!row) return false;
  try {
    await verify(token, row.jwtSecret, "HS256");
    return true;
  } catch {
    return false;
  }
}

// The gate. Order of checks mirrors apiKeyAuth exactly.
export const sessionAuth: MiddlewareHandler = async (c, next) => {
  // No password configured yet — dashboard bootstrap window (matches
  // apiKeyAuth's open-gateway pattern). The dashboard shows a "set a
  // password" banner once we've decided to require one.
  if (!hasPassword()) {
    await next();
    return;
  }

  // Loopback + HOST bound to loopback → the developer on their own machine.
  if (isLoopbackRequest(c)) {
    await next();
    return;
  }

  const token = getCookie(c, COOKIE_NAME);
  const ok = await verifySessionCookie(token);
  if (!ok) {
    if (token) clearSession(c); // stale/invalid cookie — nuke it so the client stops sending it
    return errorResponse(401, "invalid_request_error", "not authenticated");
  }

  await next();
};
