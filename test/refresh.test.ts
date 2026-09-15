// Token refresh: when the access JWT nears expiry the offline refresh token
// is exchanged upstream, the rotated pair is persisted, and a failed exchange
// kills the account so rotation moves on.

import { test, expect } from "bun:test";
import { proxyChat } from "../src/proxy";
import { Pool, type AccountRow } from "../src/pool/pool";
import { CodeBuddyProvider } from "../src/providers/codebuddy";
import type { ChatRequest } from "../src/providers/types";

const req: ChatRequest = {
  model: "claude-sonnet-4.6",
  messages: [{ role: "user", parts: [{ type: "text", text: "hi" }] }],
  stream: true,
};

const OK_SSE = `data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n`;

function fakeJwt(exp: number): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "none" })}.${b64({ exp })}.sig`;
}

function makePool(rows: AccountRow[]) {
  const credWrites: { id: number; creds: Record<string, string> }[] = [];
  const statusWrites: { id: number; status: string }[] = [];
  const pool = new Pool(
    (p) => rows.filter((r) => r.provider === p),
    () => "sticky",
    (id, status) => {
      statusWrites.push({ id, status });
      const row = rows.find((r) => r.id === id);
      if (row) row.status = status;
    },
    (id, creds) => {
      credWrites.push({ id, creds });
      const row = rows.find((r) => r.id === id);
      if (row) row.creds = creds;
    }
  );
  return { pool, credWrites, statusWrites, rows };
}

function row(id: number, over: Partial<AccountRow> = {}): AccountRow {
  return { id, provider: "codebuddy", label: `acc-${id}`, secret: "", creds: null, status: "active", ...over };
}

function refreshResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

const VALID_PAIR = {
  code: 0,
  data: { accessToken: fakeJwt(Math.floor(Date.now() / 1000) + 3600), refreshToken: "rt-new" },
};

test("an expiring access token is refreshed, persisted, and the new token serves the request", async () => {
  const expiring = fakeJwt(Math.floor(Date.now() / 1000) + 60); // 1 min left
  const { pool, credWrites, statusWrites } = makePool([
    row(1, { creds: { access_token: expiring, refresh_token: "rt-old" } }),
  ]);

  const calls: string[] = [];
  const fetchImpl = (async (input: Request | URL | string, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push(url);
    if (url.includes("/token/refresh")) {
      // Refresh is called with (url, init), so headers live on init.
      expect(new Headers(init?.headers).get("X-Refresh-Token")).toBe("rt-old");
      return refreshResponse(VALID_PAIR);
    }
    // Chat request must carry the NEW access token.
    const auth = input instanceof Request ? input.headers.get("Authorization") : null;
    expect(auth).toBe(`Bearer ${VALID_PAIR.data.accessToken}`);
    return new Response(OK_SSE, { status: 200 });
  }) as typeof globalThis.fetch;

  const provider = new CodeBuddyProvider(fetchImpl);
  const res = await proxyChat(provider, pool, req, { fetch: fetchImpl });
  expect(res.account.id).toBe(1);
  expect(await res.stream.next()).toBeTruthy();

  expect(calls[0]).toContain("/token/refresh"); // refresh before chat
  expect(credWrites).toEqual([
    { id: 1, creds: { access_token: VALID_PAIR.data.accessToken, refresh_token: "rt-new" } },
  ]);
  expect(statusWrites).toEqual([]); // account stays active
});

test("a fresh access token skips the refresh round-trip entirely", async () => {
  const fresh = fakeJwt(Math.floor(Date.now() / 1000) + 3600);
  const { pool, credWrites } = makePool([
    row(1, { creds: { access_token: fresh, refresh_token: "rt-old" } }),
  ]);

  const calls: string[] = [];
  const fetchImpl = (async (input: Request | URL | string) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push(url);
    return new Response(OK_SSE, { status: 200 });
  }) as typeof globalThis.fetch;

  const provider = new CodeBuddyProvider(fetchImpl);
  await proxyChat(provider, pool, req, { fetch: fetchImpl });

  expect(calls.some((u) => u.includes("/token/refresh"))).toBe(false);
  expect(credWrites).toEqual([]);
});

test("an RT-only account (no access_token yet) exchanges the refresh token and persists the pair", async () => {
  const { pool, credWrites, statusWrites } = makePool([
    row(1, { creds: { refresh_token: "rt-only" } }),
  ]);

  const calls: string[] = [];
  const fetchImpl = (async (input: Request | URL | string, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push(url);
    if (url.includes("/token/refresh")) {
      expect(new Headers(init?.headers).get("X-Refresh-Token")).toBe("rt-only");
      return refreshResponse(VALID_PAIR);
    }
    const auth = input instanceof Request ? input.headers.get("Authorization") : null;
    expect(auth).toBe(`Bearer ${VALID_PAIR.data.accessToken}`);
    return new Response(OK_SSE, { status: 200 });
  }) as typeof globalThis.fetch;

  const provider = new CodeBuddyProvider(fetchImpl);
  const res = await proxyChat(provider, pool, req, { fetch: fetchImpl });
  expect(res.account.id).toBe(1);
  expect(await res.stream.next()).toBeTruthy();

  expect(calls[0]).toContain("/token/refresh");
  expect(credWrites).toEqual([
    { id: 1, creds: { refresh_token: "rt-new", access_token: VALID_PAIR.data.accessToken } },
  ]);
  expect(statusWrites).toEqual([]);
});

test("a single-token account (no refresh_token) is used as-is", async () => {
  const { pool, credWrites } = makePool([row(1, { secret: "sk-static", creds: null })]);

  const calls: string[] = [];
  const fetchImpl = (async (input: Request | URL | string) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push(url);
    return new Response(OK_SSE, { status: 200 });
  }) as typeof globalThis.fetch;

  const provider = new CodeBuddyProvider(fetchImpl);
  await proxyChat(provider, pool, req, { fetch: fetchImpl });

  expect(calls.some((u) => u.includes("/token/refresh"))).toBe(false);
  expect(credWrites).toEqual([]);
});

test("a failed refresh bans the account and rotation moves to the next one", async () => {
  const expiring = fakeJwt(Math.floor(Date.now() / 1000) + 60);
  const { pool, credWrites, statusWrites } = makePool([
    row(1, { creds: { access_token: expiring, refresh_token: "rt-dead" } }),
    row(2, { creds: { access_token: fakeJwt(Math.floor(Date.now() / 1000) + 3600), refresh_token: "rt-good" } }),
  ]);

  const fetchImpl = (async (input: Request | URL | string) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("/token/refresh")) return refreshResponse({ code: 10103, msg: "invalid refresh token" });
    return new Response(OK_SSE, { status: 200 });
  }) as typeof globalThis.fetch;

  const provider = new CodeBuddyProvider(fetchImpl);
  const res = await proxyChat(provider, pool, req, { fetch: fetchImpl });

  expect(res.account.id).toBe(2); // second account served
  expect(statusWrites).toEqual([{ id: 1, status: "banned" }]);
  expect(credWrites).toEqual([]);
  expect(res.attempts[0]).toMatchObject({ account: expect.objectContaining({ id: 1 }), outcome: "dead" });
});

test("a network error during refresh falls back to the old token", async () => {
  const expiring = fakeJwt(Math.floor(Date.now() / 1000) + 60);
  const { pool, statusWrites } = makePool([
    row(1, { creds: { access_token: expiring, refresh_token: "rt-old" } }),
  ]);

  const fetchImpl = (async (input: Request | URL | string) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("/token/refresh")) throw new Error("socket hangup");
    return new Response(OK_SSE, { status: 200 });
  }) as typeof globalThis.fetch;

  const provider = new CodeBuddyProvider(fetchImpl);
  const res = await proxyChat(provider, pool, req, { fetch: fetchImpl });

  expect(res.account.id).toBe(1); // still served with the old token
  expect(statusWrites).toEqual([]);
});
