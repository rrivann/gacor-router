// End-to-end through the Hono app, against a temp DB and a stubbed upstream.
// DB_PATH is set before any import so src/db/index.ts opens the temp file.

import { test, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unlinkSync } from "node:fs";

const dbPath = join(tmpdir(), `gacor-api-test-${Bun.randomUUIDv7()}.db`);
process.env.DB_PATH = dbPath;

new Database(dbPath).exec(`
  CREATE TABLE accounts (id integer primary key autoincrement, provider text not null,
    label text, secret text default '' not null, creds text,
    status text default 'active' not null, usage_json text, usage_at integer,
    created_at integer not null);
  CREATE TABLE settings (key text primary key, value text not null);
  CREATE TABLE chat_sessions (
    id integer primary key autoincrement,
    title text not null default 'New chat',
    model text not null default '',
    messages text not null default '[]',
    msg_count integer not null default 0,
    created_at integer not null,
    updated_at integer not null
  );
  CREATE TABLE request_logs (
    id integer primary key autoincrement,
    created_at integer not null,
    provider text not null,
    model text,
    account_id integer,
    account_label text,
    stream integer default 0 not null,
    status text not null,
    http_status integer,
    outcome text,
    duration_ms integer,
    prompt_tokens integer,
    completion_tokens integer,
    total_tokens integer,
    credit_used real,
    error_message text,
    request_body text,
    response_body text
  );
  INSERT INTO accounts (provider,label,secret,status,created_at)
    VALUES ('codebuddy','acc-1','token-1','active',0);
`);

const { api } = await import("../src/api");
const { manage } = await import("../src/api/manage");
const { setSetting } = await import("../src/db/accounts");
const { onEvent } = await import("../src/lib/events");
const { setSpawnerForTests } = await import("../src/tunnel/manager");

const realFetch = globalThis.fetch;
let stub: (input: Request) => Response = () => new Response("unstubbed", { status: 500 });
let calls = 0;

beforeAll(() => {
  // Intercept only CodeBuddy; anything else keeps the real fetch.
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = typeof input === "string" ? input : input.url;
    if (url.includes("codebuddy.ai")) {
      calls++;
      return stub(input as Request);
    }
    return realFetch(input, init);
  }) as typeof fetch;
});

afterAll(() => {
  globalThis.fetch = realFetch;
  try {
    unlinkSync(dbPath);
  } catch {}
});

const OK_SSE = `data: {"choices":[{"delta":{"content":"hello"}}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":1,"credit":0.42}}\n\ndata: [DONE]\n\n`;

function chat(body: unknown, path = "/v1/chat/completions"): Promise<Response> {
  return api.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const msgs = [{ role: "user", content: "hi" }];

test("invalid JSON is a 400", async () => {
  const r = await chat("not json");
  expect(r.status).toBe(400);
  expect((await r.json()).error.type).toBe("invalid_request_error");
});

test("a missing model is a 400 naming the field", async () => {
  const r = await chat({ messages: msgs });
  expect(r.status).toBe(400);
  expect((await r.json()).error.code).toBe("model");
});

test("empty messages is a 400 naming the field", async () => {
  const r = await chat({ model: "codebuddy/claude-opus-5", messages: [] });
  expect(r.status).toBe(400);
  expect((await r.json()).error.code).toBe("messages");
});

test("an unknown provider is a 501 that lists what is available", async () => {
  const r = await chat({ model: "nope/some-model", messages: msgs });
  expect(r.status).toBe(501);
  const body = await r.json();
  expect(body.error.type).toBe("not_implemented_error");
  expect(body.error.message).toContain("codebuddy"); // available providers
});

test("a bare model id without default_provider is a 400", async () => {
  const r = await chat({ model: "claude-opus-5", messages: msgs });
  expect(r.status).toBe(400);
  expect((await r.json()).error.message).toContain("default_provider");
});

test("a non-streaming request returns an assembled completion", async () => {
  stub = () => new Response(OK_SSE, { status: 200 });
  const r = await chat({ model: "codebuddy/claude-opus-5", messages: msgs });
  expect(r.status).toBe(200);
  const body = await r.json();
  expect(body.object).toBe("chat.completion");
  expect(body.choices[0].message.content).toBe("hello");
  expect(body.usage.total_tokens).toBe(4);
});

test("a streaming request returns SSE ending in [DONE]", async () => {
  stub = () => new Response(OK_SSE, { status: 200 });
  const r = await chat({ model: "codebuddy/claude-opus-5", messages: msgs, stream: true });
  expect(r.status).toBe(200);
  expect(r.headers.get("Content-Type")).toBe("text/event-stream; charset=utf-8");
  const text = await r.text();
  expect(text).toContain('"content":"hello"');
  expect(text.endsWith("data: [DONE]\n\n")).toBe(true);
});

test("the provider prefix is stripped before reaching the upstream", async () => {
  let sentModel = "";
  stub = (input) => {
    // The body is gzipped; the model is asserted via the outgoing request.
    input
      .clone()
      .arrayBuffer()
      .then((b) => {
        const { gunzipSync } = require("node:zlib");
        sentModel = JSON.parse(gunzipSync(new Uint8Array(b)).toString()).model;
      });
    return new Response(OK_SSE, { status: 200 });
  };
  await chat({ model: "codebuddy/claude-opus-5", messages: msgs });
  await Bun.sleep(10);
  expect(sentModel).toBe("claude-opus-5");
});

test("a 200 JSON error envelope surfaces instead of a blank reply", async () => {
  // The whole point of the peek: this used to look like an empty stream.
  stub = () => new Response(`{"code":11101,"msg":"system message required"}`, { status: 200 });
  const r = await chat({ model: "codebuddy/claude-opus-5", messages: msgs });
  expect(r.status).toBe(502);
  expect((await r.json()).error.message).toContain("11101");
});

test("a dead credential exhausts the pool and the 503 explains why", async () => {
  stub = () => new Response(`{"code":11140,"msg":"request illegal"}`, { status: 200 });
  const r = await chat({ model: "codebuddy/claude-opus-5", messages: msgs });
  expect(r.status).toBe(503);
  const body = await r.json();
  expect(body.error.type).toBe("no_available_account_error");
  expect(body.error.message).toContain("acc-1");
  expect(body.error.message).toContain("dead");
});

test("the ban is persisted, so the next request never reaches the upstream", async () => {
  const before = calls;
  const r = await chat({ model: "codebuddy/claude-opus-5", messages: msgs });
  expect(r.status).toBe(503);
  expect(calls).toBe(before); // no fetch: no active account left
});

test("default_provider lets a bare model id route", async () => {
  // Reactivate the account banned above.
  new Database(dbPath).exec(`UPDATE accounts SET status='active' WHERE id=1`);
  setSetting("default_provider", "codebuddy");
  stub = () => new Response(OK_SSE, { status: 200 });
  const r = await chat({ model: "claude-opus-5", messages: msgs });
  expect(r.status).toBe(200);
  expect((await r.json()).choices[0].message.content).toBe("hello");
});

test("/v1/models lists the catalogue namespaced by provider", async () => {
  const r = await api.request("/v1/models");
  expect(r.status).toBe(200);
  const body = await r.json();
  expect(body.object).toBe("list");
  expect(body.data.length).toBe(30);
  expect(body.data.map((m: any) => m.id)).toContain("codebuddy/claude-opus-5");
  const opus = body.data.find((m: any) => m.id === "codebuddy/claude-opus-5");
  expect(opus.owned_by).toBe("anthropic");
  expect(opus.object).toBe("model");
});

test("/v1/messages is still a 501 pointing at the working route", async () => {
  const r = await chat({ model: "codebuddy/claude-opus-5", messages: msgs }, "/v1/messages");
  expect(r.status).toBe(501);
  expect((await r.json()).error.message).toContain("/v1/chat/completions");
});

// ── Management API (/api/*) ──────────────────────────────────────
// Shares this file's DB and fetch stub — bun test runs files in one process
// with a module cache, so everything touching src/db must live here.

function logRows(): Record<string, unknown>[] {
  return new Database(dbPath)
    .query("SELECT * FROM request_logs ORDER BY id")
    .all() as Record<string, unknown>[];
}

test("GET /api/accounts lists rows with secrets masked to hasSecret", async () => {
  const r = await manage.request("/accounts");
  expect(r.status).toBe(200);
  const { data } = await r.json();
  expect(data.length).toBeGreaterThan(0);
  expect(data[0].label).toBe("acc-1");
  expect(data[0].hasSecret).toBe(true);
  expect(data[0].secret).toBeUndefined();
});

test("POST /api/accounts validates provider and credentials", async () => {
  const noProvider = await manage.request("/accounts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ secret: "x" }),
  });
  expect(noProvider.status).toBe(400);

  const noCreds = await manage.request("/accounts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ provider: "codebuddy" }),
  });
  expect(noCreds.status).toBe(400);
});

test("POST /api/accounts creates, reveal returns the secret, delete removes", async () => {
  const created = await manage.request("/accounts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ provider: "codebuddy", label: "tmp-acc", secret: "tok-tmp" }),
  });
  expect(created.status).toBe(201);
  const { id } = await created.json();

  const reveal = await manage.request(`/accounts/${id}/reveal`);
  expect((await reveal.json()).secret).toBe("tok-tmp");

  const del = await manage.request(`/accounts/${id}`, { method: "DELETE" });
  expect(del.status).toBe(200);
  expect((await manage.request(`/accounts/${id}/reveal`)).status).toBe(404);
});

test("POST /api/accounts/:id/status flips status and emits account_status", async () => {
  const events: { type: string; data: unknown }[] = [];
  const off = onEvent((e) => events.push(e));

  const r = await manage.request("/accounts/1/status", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ status: "exhausted" }),
  });
  expect(r.status).toBe(200);
  expect(events).toEqual([{ type: "account_status", data: { id: 1, status: "exhausted" } }]);

  const bad = await manage.request("/accounts/1/status", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ status: "sleepy" }),
  });
  expect(bad.status).toBe(400);

  await manage.request("/accounts/1/status", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ status: "active" }),
  });
  off();
});

test("settings round-trip: PUT writes, GET reads, DELETE removes", async () => {
  const put = await manage.request("/settings", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ "pool_rotation:codebuddy": "round-robin" }),
  });
  expect(put.status).toBe(200);

  const got = await manage.request("/settings");
  const { data } = await got.json();
  expect(data["pool_rotation:codebuddy"]).toBe("round-robin");
  expect(data.default_provider).toBe("codebuddy"); // set by an earlier test

  const bad = await manage.request("/settings", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ count: 42 }),
  });
  expect(bad.status).toBe(400);

  await manage.request("/settings/pool_rotation:codebuddy", { method: "DELETE" });
  const again = await manage.request("/settings");
  expect((await again.json()).data["pool_rotation:codebuddy"]).toBeUndefined();
});

// ── Request logging via the proxy tap ────────────────────────────

test("a successful chat persists a success row and emits request_log", async () => {
  stub = () => new Response(OK_SSE, { status: 200 });
  const events: { type: string; data: unknown }[] = [];
  const off = onEvent((e) => events.push(e));

  const before = logRows().length;
  const r = await chat({ model: "codebuddy/claude-opus-5", messages: msgs });
  expect(r.status).toBe(200);
  await r.text(); // drain — persistence happens when the stream ends

  const rows = logRows();
  expect(rows.length).toBe(before + 1);
  const row = rows[rows.length - 1]!;
  expect(row.status).toBe("success");
  expect(row.provider).toBe("codebuddy");
  expect(row.model).toBe("claude-opus-5");
  expect(row.account_label).toBe("acc-1");
  expect(row.prompt_tokens).toBe(3);
  expect(row.completion_tokens).toBe(1);
  expect(row.total_tokens).toBe(4);
  expect(row.credit_used).toBe(0.42);
  expect(JSON.parse(row.response_body as string).content).toBe("hello");

  const reqEvents = events.filter((e) => e.type === "request_log");
  expect(reqEvents).toHaveLength(1);
  expect((reqEvents[0]!.data as { status: string }).status).toBe("success");
  off();
});

test("a dead upstream persists an error row with the attempt log", async () => {
  stub = () => new Response(`{"code":11140,"msg":"request illegal"}`, { status: 200 });
  const before = logRows().length;
  const r = await chat({ model: "codebuddy/claude-opus-5", messages: msgs });
  expect(r.status).toBe(503);

  const rows = logRows();
  expect(rows.length).toBe(before + 1);
  const row = rows[rows.length - 1]!;
  expect(row.status).toBe("error");
  expect(row.error_message).toContain("failed");
  expect(row.response_body).toContain("11140");

  new Database(dbPath).exec(`UPDATE accounts SET status='active' WHERE id=1`);
});

test("an upstream 500 persists an error row with httpStatus", async () => {
  stub = () => new Response("upstream exploded", { status: 500 });
  const before = logRows().length;
  const r = await chat({ model: "codebuddy/claude-opus-5", messages: msgs });
  expect(r.status).toBe(502);

  const rows = logRows();
  expect(rows.length).toBe(before + 1);
  const row = rows[rows.length - 1]!;
  expect(row.status).toBe("error");
  expect(row.http_status).toBe(500);
});

test("GET /api/stats/requests omits bodies; detail returns them", async () => {
  const list = await manage.request("/stats/requests?limit=10");
  expect(list.status).toBe(200);
  const { data } = await list.json();
  expect(data.length).toBeGreaterThan(0);
  expect(data[0].requestBody).toBeUndefined();
  expect(data[0].responseBody).toBeUndefined();

  const detail = await manage.request(`/stats/requests/${data[0].id}`);
  const { data: full } = await detail.json();
  expect(full.requestBody).toBeTruthy();
});

test("GET /api/stats/requests filters by provider", async () => {
  const none = await manage.request("/stats/requests?provider=nope");
  expect((await none.json()).data).toHaveLength(0);
  const some = await manage.request("/stats/requests?provider=codebuddy");
  expect((await some.json()).data.length).toBeGreaterThan(0);
});

test("GET /api/stats/dashboard aggregates pool, requests, tokens", async () => {
  const r = await manage.request("/stats/dashboard");
  const stats = await r.json();
  expect(stats.pool.total).toBeGreaterThan(0);
  expect(stats.requests.total).toBeGreaterThan(0);
  expect(stats.requests.success).toBeGreaterThan(0);
  expect(stats.tokens.prompt).toBeGreaterThan(0);
});

test("GET /api/stats/models groups usage by model", async () => {
  const r = await manage.request("/stats/models");
  const { data } = await r.json();
  expect(data.length).toBeGreaterThan(0);
  expect(data[0].provider).toBe("codebuddy");
  expect(data[0].model).toBe("claude-opus-5");
});

// ── Tunnel (/api/tunnel/*) ───────────────────────────────────────
// The spawner is stubbed — no binary download, no real cloudflared.

test("tunnel enable persists URL and status reflects it", async () => {
  setSpawnerForTests(async () => ({ url: "https://test-tunnel-abc.trycloudflare.com" }));

  const before = await (await manage.request("/tunnel/status")).json();
  expect(before.enabled).toBe(false);

  const r = await manage.request("/tunnel/enable", { method: "POST" });
  expect(r.status).toBe(200);
  const body = await r.json();
  expect(body.success).toBe(true);
  expect(body.url).toBe("https://test-tunnel-abc.trycloudflare.com");

  const status = await (await manage.request("/tunnel/status")).json();
  expect(status.enabled).toBe(true);
  expect(status.url).toBe("https://test-tunnel-abc.trycloudflare.com");
  expect(status.enabling).toBe(false);
});

test("concurrent enables join the same spawn", async () => {
  let spawnCount = 0;
  // Gate the stub spawn on a promise we resolve manually — the second enable
  // must arrive while the first is genuinely in flight, no wall-clock guess.
  let release: (() => void) | null = null;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let spawnEntered: () => void;
  const entered = new Promise<void>((resolve) => (spawnEntered = resolve));
  setSpawnerForTests(async () => {
    spawnCount++;
    spawnEntered!();
    await gate;
    return { url: "https://joined-tunnel.trycloudflare.com" };
  });

  const first = manage.request("/tunnel/enable", { method: "POST" });
  await entered; // first enable is genuinely inside the spawn
  const second = manage.request("/tunnel/enable", { method: "POST" });
  release!();
  const [a, b] = await Promise.all([first, second]);
  expect((await a.json()).url).toBe("https://joined-tunnel.trycloudflare.com");
  expect((await b.json()).url).toBe("https://joined-tunnel.trycloudflare.com");
  expect(spawnCount).toBe(1);
});

test("a failing spawn surfaces a 502 and clears enabled", async () => {
  setSpawnerForTests(async () => {
    throw new Error("cloudflared exited (code 1)");
  });
  const r = await manage.request("/tunnel/enable", { method: "POST" });
  expect(r.status).toBe(502);
  expect((await r.json()).error.message).toContain("cloudflared");

  const status = await (await manage.request("/tunnel/status")).json();
  expect(status.enabled).toBe(false);
});

test("disable clears the URL and flips enabled off", async () => {
  setSpawnerForTests(async () => ({ url: "https://to-be-disabled.trycloudflare.com" }));
  await manage.request("/tunnel/enable", { method: "POST" });

  const r = await manage.request("/tunnel/disable", { method: "POST" });
  expect(r.status).toBe(200);
  expect((await r.json()).success).toBe(true);

  const status = await (await manage.request("/tunnel/status")).json();
  expect(status.enabled).toBe(false);
  expect(status.url).toBeFalsy();
});

// ── Account usage endpoints ──────────────────────────────────────
// The CodeBuddy fetch stub doubles as the billing endpoint; the fixture
// carries one monthly plan + one lifetime pack.

const USAGE_BILLING = {
  code: 0,
  msg: "",
  data: {
    Response: {
      Data: {
        Accounts: [
          {
            PackageName: "Free Plan Subscription",
            SubProductName: "Free Plan Subscription",
            SubProductCode: "sp_free",
            Status: 0,
            CapacitySize: 100,
            CapacityUsed: 0,
            CapacityRemain: 100,
            CycleCapacitySize: 100,
            CycleCapacityUsed: 0,
            CycleCapacityRemain: 100,
            CapacitySizePrecise: "100",
            CapacityUsedPrecise: "0",
            CapacityRemainPrecise: "100",
            CycleCapacitySizePrecise: "100",
            CycleEndTime: "2026-09-30 23:59:59",
          },
          {
            PackageName: "Bonus Pack",
            SubProductName: "Bonus Pack",
            SubProductCode: "sp_bonus",
            Status: 0,
            CapacitySize: 30,
            CapacityUsed: 6,
            CapacityRemain: 24,
            CycleCapacitySize: 0,
            CapacitySizePrecise: "30",
            CapacityUsedPrecise: "6",
            CapacityRemainPrecise: "24",
            CycleCapacitySizePrecise: "0",
            CycleEndTime: "2026-09-28 23:59:59",
          },
        ],
      },
    },
  },
};

test("usage refresh fetches, caches, and the list row carries it", async () => {
  stub = (input) => {
    const url = typeof input === "string" ? input : input.url;
    if (url.includes("billing/meter")) {
      return new Response(JSON.stringify(USAGE_BILLING), { status: 200 });
    }
    return new Response(OK_SSE, { status: 200 });
  };

  // Nothing cached yet.
  const empty = await manage.request("/accounts/1/usage");
  expect((await empty.json()).data).toBeNull();

  const refresh = await manage.request("/accounts/1/usage/refresh", { method: "POST" });
  expect(refresh.status).toBe(200);
  const { data } = await refresh.json();
  expect(data.limit).toBe(130);
  expect(data.remaining).toBe(124);
  expect(data.plan).toBe("Free Plan Subscription");
  expect(data.packages).toHaveLength(2);

  // Cached now — GET returns it without another upstream call.
  const cached = await manage.request("/accounts/1/usage");
  const cachedBody = await cached.json();
  expect(cachedBody.data.limit).toBe(130);
  expect(cachedBody.fetchedAt).toBeTruthy();

  // And the accounts list carries the snapshot inline.
  const list = await manage.request("/accounts");
  const row = (await list.json()).data.find((a: { id: number }) => a.id === 1);
  expect(row.usage.limit).toBe(130);
  expect(row.usageAt).toBeTruthy();
});

test("usage refresh on a missing account is a 404", async () => {
  const r = await manage.request("/accounts/999/usage/refresh", { method: "POST" });
  expect(r.status).toBe(404);
});

test("usage refresh with a dead upstream surfaces a 502", async () => {
  stub = () => new Response("billing exploded", { status: 500 });
  const r = await manage.request("/accounts/1/usage/refresh", { method: "POST" });
  expect(r.status).toBe(502);
});

// ── AI Chat sessions ─────────────────────────────────────────────

test("chat sessions: create → list (no blob) → get (with blob) → update → delete", async () => {
  const created = await manage.request("/chat/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "codebuddy/claude-opus-5" }),
  });
  expect(created.status).toBe(201);
  const { id } = await created.json();

  // List is lightweight — no messages blob.
  const list = await manage.request("/chat/sessions");
  const { sessions } = await list.json();
  const row = sessions.find((s: { id: number }) => s.id === id);
  expect(row.title).toBe("New chat");
  expect(row.model).toBe("codebuddy/claude-opus-5");
  expect(row.messages).toBeUndefined();

  // Update with a messages blob + derived title.
  const msgs = JSON.stringify([
    { role: "user", content: "hello there" },
    { role: "assistant", content: "hi!" },
  ]);
  const upd = await manage.request(`/chat/sessions/${id}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "hello there", messages: msgs, msgCount: 2 }),
  });
  expect(upd.status).toBe(200);

  // Get returns the full row including the blob.
  const got = await manage.request(`/chat/sessions/${id}`);
  const full = await got.json();
  expect(full.title).toBe("hello there");
  expect(JSON.parse(full.messages)).toHaveLength(2);
  expect(full.msgCount).toBe(2);

  const del = await manage.request(`/chat/sessions/${id}`, { method: "DELETE" });
  expect(del.status).toBe(200);
  expect((await manage.request(`/chat/sessions/${id}`)).status).toBe(404);
});

test("updating a missing session is a 404", async () => {
  const r = await manage.request("/chat/sessions/999", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "x" }),
  });
  expect(r.status).toBe(404);
});
