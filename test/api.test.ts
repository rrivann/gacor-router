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
    source text default 'proxy' not null,
    status text not null,
    http_status integer,
    outcome text,
    duration_ms integer,
    prompt_tokens integer,
    completion_tokens integer,
    total_tokens integer,
    cached_tokens integer,
    cache_write_tokens integer,
    reasoning_tokens integer,
    ttft_ms integer,
    credit_used real,
    dollar_cost real,
    error_message text,
    request_body text,
    response_body text
  );
  CREATE TABLE content_filters (
    id integer primary key autoincrement,
    pattern text not null,
    replacement text not null default '',
    is_regex integer not null default 0,
    is_active integer not null default 1,
    sort integer not null default 0,
    provider_scope text,
    created_at integer not null
  );
  CREATE TABLE api_keys (
    id integer primary key autoincrement,
    label text not null default '',
    secret text not null,
    enabled integer not null default 1,
    token_limit integer not null default 0,
    tokens_used integer not null default 0,
    max_concurrent integer not null default 0,
    expires_at integer,
    last_used_at integer,
    allowed_models text,
    allowed_providers text,
    created_at integer not null
  );
  CREATE UNIQUE INDEX idx_api_keys_secret ON api_keys (secret);
  CREATE TABLE video_jobs (
    id integer primary key autoincrement,
    provider text not null,
    model text not null,
    account_id integer not null,
    account_label text,
    api_key_id integer,
    task_id text not null,
    status text default 'queued' not null,
    params text not null,
    file_path text,
    file_size integer,
    video_url text,
    credit_used real,
    dollar_cost real,
    error_message text,
    request_log_id integer,
    created_at integer not null,
    updated_at integer,
    completed_at integer
  );
  CREATE INDEX idx_video_jobs_status_created ON video_jobs (status, created_at);
  CREATE INDEX idx_video_jobs_task ON video_jobs (task_id);
  CREATE TABLE dashboard_auth (
    id integer primary key autoincrement,
    password_hash text not null,
    jwt_secret text not null,
    created_at integer not null,
    updated_at integer not null
  );
  INSERT INTO accounts (provider,label,secret,status,created_at)
    VALUES ('codebuddy','acc-1','token-1','active',0);
`);

const { api } = await import("../src/api");
const { manage } = await import("../src/api/manage");
const { setSetting } = await import("../src/db/accounts");
const { onEvent } = await import("../src/lib/events");
const { setSpawnerForTests } = await import("../src/tunnel/manager");
const { setRunningOverrideForTests } = await import("../src/tunnel/cloudflared");
// The bun-sqlite singleton — whichever test file loaded first binds it. Use
// it for direct schema pokes so writes hit the DB the app actually reads.
const { sqlite: liveDb } = await import("../src/db/index");

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
  // Use a name that isn't in the model alias table — a whitelist entry
  // like "claude-opus-5" would auto-resolve to codebuddy and this test
  // is specifically about the no-alias / no-fallback path.
  const r = await chat({ model: "unknown-bare-model", messages: msgs });
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
  liveDb.exec(`UPDATE accounts SET status='active' WHERE id=1`);
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
  expect(body.data.length).toBe(34);
  expect(body.data.map((m: any) => m.id)).toContain("codebuddy/gpt-6-astra");
  expect(body.data.map((m: any) => m.id)).toContain("codebuddy/seedance-2.5");
  const astra = body.data.find((m: any) => m.id === "codebuddy/gpt-6-astra");
  expect(astra.owned_by).toBe("openai");
  expect(astra.credit_multiplier).toBe(6.67);
  expect(astra.thinking).toBe(true);
  expect(astra.name).toBe("GPT-6-Astra");
  expect(astra.object).toBe("model");
});

test("/v1/models with remove headers returns remove-shape envelope", async () => {
  // remove SDK's models.list() unmarshals a fixed shape. Setting either
  // header is enough — Code Assistant sends both, but each alone is a strong
  // signal since the 0penAI SDK never sends either.
  const r = await api.request("/v1/models", {
    headers: { "anthr0pic-version": "2023-06-01" },
  });
  expect(r.status).toBe(200);
  const body = await r.json();
  // No `object: "list"` here — that's the 0penAI signal we deliberately drop.
  expect(body.object).toBeUndefined();
  expect(body.has_more).toBe(false);
  expect(typeof body.first_id).toBe("string");
  expect(typeof body.last_id).toBe("string");
  expect(Array.isArray(body.data)).toBe(true);
  const first = body.data[0];
  expect(first.type).toBe("model");
  expect(typeof first.id).toBe("string");
  expect(typeof first.display_name).toBe("string");
  expect(typeof first.created_at).toBe("string");
});

test("/v1/models/:id returns the single model in the negotiated shape", async () => {
  const encodedId = encodeURIComponent("codebuddy/claude-opus-4.7-1m");
  // remove-shape response.
  const anthr0pic = await api.request(`/v1/models/${encodedId}`, {
    headers: { "anthr0pic-version": "2023-06-01" },
  });
  expect(anthr0pic.status).toBe(200);
  const abody = await anthr0pic.json();
  expect(abody.type).toBe("model");
  expect(abody.id).toBe("codebuddy/claude-opus-4.7-1m");
  expect(typeof abody.display_name).toBe("string");

  // 0penAI-shape response.
  const openai = await api.request(`/v1/models/${encodedId}`);
  expect(openai.status).toBe(200);
  const obody = await openai.json();
  expect(obody.object).toBe("model");
  expect(obody.id).toBe("codebuddy/claude-opus-4.7-1m");
});

test("/v1/models/:id returns 404 with the right envelope per client", async () => {
  const anthr0pic = await api.request("/v1/models/codebuddy/nope-model", {
    headers: { "anthr0pic-version": "2023-06-01" },
  });
  expect(anthr0pic.status).toBe(404);
  const abody = await anthr0pic.json();
  expect(abody.type).toBe("error");
  expect(abody.error.type).toBe("not_found_error");
  expect(abody.error.message).toContain("nope-model");

  const openai = await api.request("/v1/models/codebuddy/nope-model");
  expect(openai.status).toBe(404);
  const obody = await openai.json();
  expect(obody.error.message).toContain("nope-model");
});

test("resolveModel unwraps a native alias to provider/model", async () => {
  const { resolveModel } = await import("../src/lib/model");
  const route = resolveModel("claude-opus-4-7[1m]");
  expect(route).toEqual({ provider: "codebuddy", model: "claude-opus-4.7-1m" });
});

test("resolveModel is lenient: provider-prefixed alias still resolves", async () => {
  // A client that keeps the provider prefix (`codebuddy/claude-opus-4-7[1m]`)
  // gets routed the same way as the bare alias — otherwise the tail would
  // pass through verbatim and hit the upstream with a name it doesn't know.
  const { resolveModel } = await import("../src/lib/model");
  const route = resolveModel("codebuddy/claude-opus-4-7[1m]");
  expect(route).toEqual({ provider: "codebuddy", model: "claude-opus-4.7-1m" });
});

test("/v1/models remove shape lists aliases the client whitelists", async () => {
  const r = await api.request("/v1/models", {
    headers: { "anthr0pic-version": "2023-06-01" },
  });
  const body = await r.json();
  const ids: string[] = body.data.map((m: { id: string }) => m.id);
  expect(ids).toContain("claude-opus-4-7[1m]");
  expect(ids).toContain("claude-opus-4-7");
  expect(ids).toContain("claude-opus-5");
  expect(ids).toContain("claude-sonnet-4-6");
  // Non-remove models keep their canonical id — the alias table only covers
  // the CL4ude family.
  expect(ids).toContain("codebuddy/gpt-6-astra");
});

test("/v1/models/:id resolves an alias and echoes the requested id", async () => {
  const encoded = encodeURIComponent("claude-opus-4-7[1m]");
  const r = await api.request(`/v1/models/${encoded}`, {
    headers: { "anthr0pic-version": "2023-06-01" },
  });
  expect(r.status).toBe(200);
  const body = await r.json();
  expect(body.type).toBe("model");
  // Response id echoes the alias the client asked for, not the canonical —
  // remove SDK matches request vs response by id.
  expect(body.id).toBe("claude-opus-4-7[1m]");
});

// ── /v1/messages (Anthropic-compatible) ──────────────────────────
// Same pool, proxy, and logging as /v1/chat/completions; only the request
// conversion and the response rendering differ.

test("/v1/messages assembles an Anthropic message", async () => {
  stub = () => new Response(OK_SSE, { status: 200 });
  const r = await chat(
    { model: "codebuddy/claude-opus-5", messages: msgs, max_tokens: 64 },
    "/v1/messages"
  );
  expect(r.status).toBe(200);
  const body = await r.json();
  expect(body.type).toBe("message");
  expect(body.role).toBe("assistant");
  expect(body.content).toEqual([{ type: "text", text: "hello" }]);
  expect(body.stop_reason).toBe("end_turn");
  expect(body.usage).toEqual({ input_tokens: 3, output_tokens: 1 });
});

test("/v1/messages streams the Anthropic event sequence", async () => {
  stub = () => new Response(OK_SSE, { status: 200 });
  const r = await chat(
    { model: "codebuddy/claude-opus-5", messages: msgs, max_tokens: 64, stream: true },
    "/v1/messages"
  );
  expect(r.status).toBe(200);
  expect(r.headers.get("Content-Type")).toBe("text/event-stream; charset=utf-8");
  const text = await r.text();
  expect(text.startsWith("event: message_start\n")).toBe(true);
  expect(text).toContain('"text_delta"');
  expect(text).toContain('"text":"hello"');
  expect(text).toContain("event: message_stop\n");
});

// The Anthropic system field is a sibling of messages, not a message; it has
// to reach the upstream as the leading system turn.
test("/v1/messages lifts the system field into the upstream messages", async () => {
  let sent: any = null;
  stub = (input) => {
    input
      .clone()
      .arrayBuffer()
      .then((b) => {
        const { gunzipSync } = require("node:zlib");
        sent = JSON.parse(gunzipSync(new Uint8Array(b)).toString());
      });
    return new Response(OK_SSE, { status: 200 });
  };
  await chat(
    { model: "codebuddy/claude-opus-5", system: "be brief", messages: msgs, max_tokens: 64 },
    "/v1/messages"
  );
  await Bun.sleep(10);
  expect(sent.messages[0]).toEqual({ role: "system", content: "be brief" });
  expect(sent.messages[1].content).toBe("hi");
});

test("/v1/messages errors keep the OpenAI error envelope", async () => {
  stub = () => new Response(`{"code":11101,"msg":"system message required"}`, { status: 200 });
  const r = await chat({ model: "codebuddy/claude-opus-5", messages: msgs }, "/v1/messages");
  expect(r.status).toBe(502);
  expect((await r.json()).error.message).toContain("11101");
});

test("/v1/messages requests are logged like any other proxied request", async () => {
  stub = () => new Response(OK_SSE, { status: 200 });
  const before = logRows().length;
  await chat({ model: "codebuddy/claude-opus-5", messages: msgs }, "/v1/messages");
  const rows = logRows();
  expect(rows.length).toBe(before + 1);
  expect(rows[rows.length - 1]!.model).toBe("claude-opus-5");
  expect(rows[rows.length - 1]!.status).toBe("success");
});

// ── Management API (/api/*) ──────────────────────────────────────
// Shares this file's DB and fetch stub — bun test runs files in one process
// with a module cache, so everything touching src/db must live here.

function logRows(): Record<string, unknown>[] {
  return liveDb
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

test("POST /api/accounts/delete-bulk removes many and reports missing ids", async () => {
  // Seed three throwaway accounts so we can watch the batch tick down.
  const ids: number[] = [];
  for (let i = 0; i < 3; i++) {
    const r = await manage.request("/accounts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "codebuddy", label: `bulk-${i}`, secret: `tok-bulk-${i}-${Bun.randomUUIDv7()}` }),
    });
    expect(r.status).toBe(201);
    ids.push((await r.json()).id as number);
  }

  // Include a bogus id so we can assert the batch keeps going + surfaces it.
  const missing = 987654321;
  const res = await manage.request("/accounts/delete-bulk", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ids: [...ids, missing] }),
  });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.success).toBe(true);
  expect(body.deleted).toBe(3);
  expect(body.failed).toEqual([missing]);

  // Every seeded id should now be gone.
  for (const id of ids) {
    expect((await manage.request(`/accounts/${id}/reveal`)).status).toBe(404);
  }
});

test("POST /api/accounts/delete-bulk rejects empty and malformed payloads", async () => {
  const noBody = await manage.request("/accounts/delete-bulk", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  expect(noBody.status).toBe(400);

  const emptyArr = await manage.request("/accounts/delete-bulk", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ids: [] }),
  });
  expect(emptyArr.status).toBe(400);
});

test("POST /api/accounts accepts creds.api_key credential (ck_ prefix)", async () => {
  const secret = "ck_test_" + Bun.randomUUIDv7();
  const created = await manage.request("/accounts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ provider: "codebuddy", creds: { api_key: secret } }),
  });
  expect(created.status).toBe(201);
  const { id } = await created.json();

  // Label should auto-derive from the api_key fingerprint (first 3 + last 4).
  const list = await manage.request("/accounts?provider=codebuddy");
  const row = ((await list.json()).data as { id: number; label: string | null }[]).find((r) => r.id === id);
  expect(row?.label).toBe(`${secret.slice(0, 3)}…${secret.slice(-4)}`);

  await manage.request(`/accounts/${id}`, { method: "DELETE" });
});

test("POST /api/accounts rejects duplicate api_key with 409", async () => {
  const secret = "ck_dup_" + Bun.randomUUIDv7();
  const first = await manage.request("/accounts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ provider: "codebuddy", creds: { api_key: secret } }),
  });
  expect(first.status).toBe(201);
  const { id: firstId } = await first.json();

  const dup = await manage.request("/accounts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ provider: "codebuddy", creds: { api_key: secret } }),
  });
  expect(dup.status).toBe(409);
  expect((await dup.json()).error.message).toContain("api_key already used");

  await manage.request(`/accounts/${firstId}`, { method: "DELETE" });
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

  liveDb.exec(`UPDATE accounts SET status='active' WHERE id=1`);
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
  // Stub spawner never actually starts cloudflared, so the coherent-status
  // gate would collapse `enabled` to false. Fake liveness so we can assert
  // the happy path here; a dedicated test below covers the dead-process case.
  setRunningOverrideForTests(() => true);

  const before = await (await manage.request("/tunnel/status")).json();
  expect(before.enabled).toBe(false); // settings still off before enable

  const r = await manage.request("/tunnel/enable", { method: "POST" });
  expect(r.status).toBe(200);
  const body = await r.json();
  expect(body.success).toBe(true);
  expect(body.url).toBe("https://test-tunnel-abc.trycloudflare.com");

  const status = await (await manage.request("/tunnel/status")).json();
  expect(status.enabled).toBe(true);
  expect(status.settingsEnabled).toBe(true);
  expect(status.running).toBe(true);
  expect(status.url).toBe("https://test-tunnel-abc.trycloudflare.com");
  expect(status.enabling).toBe(false);

  setRunningOverrideForTests(null);
});

test("tunnel enable mints a persistent shortId and stable public URL", async () => {
  setSpawnerForTests(async () => ({ url: "https://persist-test.trycloudflare.com" }));
  setRunningOverrideForTests(() => true);

  // Reset settings so we exercise the mint-fresh path.
  liveDb.exec("DELETE FROM settings WHERE key LIKE 'tunnel_%'");

  const first = await manage.request("/tunnel/enable", { method: "POST" });
  expect(first.status).toBe(200);
  const firstBody = await first.json();
  expect(typeof firstBody.shortId).toBe("string");
  expect(firstBody.shortId).toHaveLength(6);

  const status1 = await (await manage.request("/tunnel/status")).json();
  expect(status1.shortId).toBe(firstBody.shortId);
  expect(status1.publicUrl).toBe(`https://r${firstBody.shortId}.abc-tunnel.us`);
  expect(status1.publicUrlEnabled).toBe(true);

  // Disable then re-enable — the shortId must be reused so bookmarks stay valid.
  await manage.request("/tunnel/disable", { method: "POST" });
  const second = await manage.request("/tunnel/enable", { method: "POST" });
  const secondBody = await second.json();
  expect(secondBody.shortId).toBe(firstBody.shortId);

  setRunningOverrideForTests(null);
});

test("PUT /api/tunnel/public-url toggles the feature and hides the stable URL when off", async () => {
  setSpawnerForTests(async () => ({ url: "https://toggle-test.trycloudflare.com" }));
  setRunningOverrideForTests(() => true);

  liveDb.exec("DELETE FROM settings WHERE key LIKE 'tunnel_%'");
  await manage.request("/tunnel/enable", { method: "POST" });

  // Turn public URL off.
  const off = await manage.request("/tunnel/public-url", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ enabled: false }),
  });
  expect(off.status).toBe(200);
  expect((await off.json()).enabled).toBe(false);

  const statusOff = await (await manage.request("/tunnel/status")).json();
  expect(statusOff.publicUrlEnabled).toBe(false);
  expect(statusOff.publicUrl).toBeNull();
  // Direct URL and shortId are unaffected.
  expect(statusOff.url).toBe("https://toggle-test.trycloudflare.com");
  expect(typeof statusOff.shortId).toBe("string");

  // Malformed payload → 400.
  const bad = await manage.request("/tunnel/public-url", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  expect(bad.status).toBe(400);

  setRunningOverrideForTests(null);
});

test("POST /api/tunnel/regenerate-short-id mints a new id, invalidating the old one", async () => {
  liveDb.exec("DELETE FROM settings WHERE key LIKE 'tunnel_%'");
  setSpawnerForTests(async () => ({ url: "https://regen-test.trycloudflare.com" }));
  setRunningOverrideForTests(() => true);
  const enable = await (await manage.request("/tunnel/enable", { method: "POST" })).json();
  const oldId = enable.shortId as string;

  const regen = await manage.request("/tunnel/regenerate-short-id", { method: "POST" });
  expect(regen.status).toBe(200);
  const regenBody = await regen.json();
  expect(regenBody.shortId).toHaveLength(6);
  expect(regenBody.shortId).not.toBe(oldId);

  const status = await (await manage.request("/tunnel/status")).json();
  expect(status.shortId).toBe(regenBody.shortId);

  setRunningOverrideForTests(null);
});

test("status reports disconnected when settings say enabled but cloudflared is dead", async () => {
  // Set up: enable with fake liveness so URL persists.
  setSpawnerForTests(async () => ({ url: "https://coherent-abc.trycloudflare.com" }));
  setRunningOverrideForTests(() => true);
  await manage.request("/tunnel/enable", { method: "POST" });

  // Simulate the screenshot bug: cloudflared has since died.
  setRunningOverrideForTests(() => false);

  const status = await (await manage.request("/tunnel/status")).json();
  // The coherent contract: user's intent is preserved, but `enabled` reflects
  // the actual liveness, and the stale URL is hidden so the dashboard cannot
  // render a dead https://... as ONLINE.
  expect(status.settingsEnabled).toBe(true);
  expect(status.running).toBe(false);
  expect(status.enabled).toBe(false);
  expect(status.url).toBeNull();

  setRunningOverrideForTests(null);
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

test("usage refresh flips an active account to exhausted when credits hit zero", async () => {
  const zeroCredit = {
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
              CapacityUsed: 100,
              CapacityRemain: 0,
              CycleCapacitySize: 100,
              CycleCapacityUsed: 100,
              CycleCapacityRemain: 0,
              CapacitySizePrecise: "100",
              CapacityUsedPrecise: "100",
              CapacityRemainPrecise: "0",
              CycleCapacitySizePrecise: "100",
              CycleCapacityUsedPrecise: "100",
              CycleCapacityRemainPrecise: "0",
              CycleEndTime: "2026-09-30 23:59:59",
            },
          ],
        },
      },
    },
  };
  stub = () => new Response(JSON.stringify(zeroCredit), { status: 200 });

  // Precondition: still active from earlier tests.
  const before = await manage.request("/accounts");
  const rowBefore = (await before.json()).data.find((a: { id: number }) => a.id === 1);
  expect(rowBefore.status).toBe("active");

  const r = await manage.request("/accounts/1/usage/refresh", { method: "POST" });
  expect(r.status).toBe(200);

  const after = await manage.request("/accounts");
  const rowAfter = (await after.json()).data.find((a: { id: number }) => a.id === 1);
  expect(rowAfter.status).toBe("exhausted");
});

test("usage refresh re-arms an exhausted account when credits refill", async () => {
  stub = () => new Response(JSON.stringify(USAGE_BILLING), { status: 200 });
  const r = await manage.request("/accounts/1/usage/refresh", { method: "POST" });
  expect(r.status).toBe(200);

  const after = await manage.request("/accounts");
  const row = (await after.json()).data.find((a: { id: number }) => a.id === 1);
  expect(row.status).toBe("active");
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

// ── Process debug ────────────────────────────────────────────────

test("GET /api/debug/process reports cpu, memory, build, uptime", async () => {
  const r = await manage.request("/debug/process");
  expect(r.status).toBe(200);
  const d = await r.json();

  expect(typeof d.process.cpuPercent).toBe("number");
  expect(d.process.cpuPercent).toBeGreaterThanOrEqual(0);
  expect(d.process.rss).toBeGreaterThan(0);
  expect(d.process.pid).toBeGreaterThan(0);

  expect(d.memory.heapUsed).toBeGreaterThan(0);
  expect(d.memory.heapTotal).toBeGreaterThan(0);

  expect(typeof d.eventLoop.delayMs).toBe("number");
  expect(d.build.platform).toBe(process.platform);
  expect(d.build.arch).toBe(process.arch);
  expect(d.build.numCpu).toBeGreaterThan(0);
  expect(typeof d.build.bunVersion).toBe("string");

  expect(d.uptimeSeconds).toBeGreaterThanOrEqual(0);
  expect(typeof d.now).toBe("string");
});

test("cpu sampling moves between polls (delta window works)", async () => {
  await manage.request("/debug/process"); // prime the baseline
  // Burn a little CPU so the delta window has something to measure.
  let x = 0;
  for (let i = 0; i < 5_000_000; i++) x += Math.sqrt(i);
  const r = await manage.request("/debug/process");
  const d = await r.json();
  expect(d.process.cpuPercent).toBeGreaterThan(0);
});

// ── Warmup ───────────────────────────────────────────────────────
// The probe is a real CodeBuddy-shaped request against glm-5.2; the fetch
// stub answers with the provider's own response shapes, and classify drives
// the status update — same as the live path.

test("a healthy probe warms the account, refreshes credit, and keeps it active", async () => {
  stub = (input) => {
    const url = typeof input === "string" ? input : input.url;
    if (url.includes("billing/meter")) {
      return new Response(JSON.stringify(USAGE_BILLING), { status: 200 });
    }
    return new Response(OK_SSE, { status: 200 });
  };

  const before = logRows().length;
  const r = await manage.request("/accounts/1/warmup", { method: "POST" });
  expect(r.status).toBe(200);
  const body = await r.json();
  expect(body.ok).toBe(true);
  expect(body.outcome).toBe("ok");
  expect(body.status).toBe("active");
  expect(body.latencyMs).toBeGreaterThanOrEqual(0);
  expect(body.credit.remaining).toBe(124);
  expect(body.credit.limit).toBe(130);

  // The probe is recorded in the request log with source="warmup".
  const rows = logRows();
  expect(rows.length).toBe(before + 1);
  const row = rows[rows.length - 1]!;
  expect(row.source).toBe("warmup");
  expect(row.model).toBe("glm-5.2");
  expect(row.status).toBe("success");
});

test("a quota probe marks the account exhausted", async () => {
  stub = () => new Response(`{"error":"insufficient_quota"}`, { status: 429 });
  const r = await manage.request("/accounts/1/warmup", { method: "POST" });
  const body = await r.json();
  expect(body.ok).toBe(false);
  expect(body.outcome).toBe("exhausted");
  expect(body.status).toBe("exhausted");

  const acc = await (await manage.request("/accounts")).json();
  expect(acc.data.find((a: { id: number }) => a.id === 1).status).toBe("exhausted");

  // A good probe later re-arms an exhausted account.
  stub = (input) => {
    const url = typeof input === "string" ? input : input.url;
    if (url.includes("billing/meter")) return new Response(JSON.stringify(USAGE_BILLING), { status: 200 });
    return new Response(OK_SSE, { status: 200 });
  };
  const r2 = await manage.request("/accounts/1/warmup", { method: "POST" });
  expect((await r2.json()).status).toBe("active");
});

test("a dead-marker probe bans the account and a good probe re-arms it", async () => {
  stub = () => new Response(`{"code":11140,"msg":"request illegal"}`, { status: 200 });
  const r = await manage.request("/accounts/1/warmup", { method: "POST" });
  expect((await r.json()).status).toBe("banned");

  stub = () => new Response(OK_SSE, { status: 200 });
  const r2 = await manage.request("/accounts/1/warmup", { method: "POST" });
  const body2 = await r2.json();
  expect(body2.ok).toBe(true);
  expect(body2.status).toBe("active"); // a live probe proves the credential works

  liveDb.exec(`UPDATE accounts SET status='active' WHERE id=1`);
});

test("warmup-all probes the provider's accounts and reports per-account results", async () => {
  stub = (input) => {
    const url = typeof input === "string" ? input : input.url;
    if (url.includes("billing/meter")) return new Response(JSON.stringify(USAGE_BILLING), { status: 200 });
    return new Response(OK_SSE, { status: 200 });
  };
  const r = await manage.request("/accounts/warmup-all?provider=codebuddy", { method: "POST" });
  expect(r.status).toBe(200);
  const body = await r.json();
  expect(body.success).toBe(true);
  expect(body.total).toBe(1);
  expect(body.ok).toBe(1);
  expect(body.results[0]).toMatchObject({ id: 1, ok: true, status: "active" });

  const missing = await manage.request("/accounts/warmup-all", { method: "POST" });
  expect(missing.status).toBe(400);
});

test("account creation warms inline and returns the probe result", async () => {
  stub = (input) => {
    const url = typeof input === "string" ? input : input.url;
    if (url.includes("billing/meter")) return new Response(JSON.stringify(USAGE_BILLING), { status: 200 });
    return new Response(OK_SSE, { status: 200 });
  };
  const r = await manage.request("/accounts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ provider: "codebuddy", label: "warm-new", secret: "tok-warm" }),
  });
  expect(r.status).toBe(201);
  const body = await r.json();
  expect(body.warmup.ok).toBe(true);
  expect(body.warmup.status).toBe("active");
  await manage.request(`/accounts/${body.id}`, { method: "DELETE" });
});

test("auto-warmup config round-trips and the scheduler warms due accounts only", async () => {
  // Default: disabled.
  const def = await (await manage.request("/providers/codebuddy/auto-warmup")).json();
  expect(def.enabled).toBe(false);
  expect(def.concurrency).toBe(2);
  expect(def.skipRecentlyWarmed).toBe(true);

  const put = await manage.request("/providers/codebuddy/auto-warmup", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ enabled: true, intervalMinutes: 30, statuses: ["active"], concurrency: 4, skipRecentlyWarmed: false }),
  });
  expect(put.status).toBe(200);
  const cfg = await put.json();
  expect(cfg).toMatchObject({
    enabled: true,
    intervalMinutes: 30,
    statuses: ["active"],
    concurrency: 4,
    skipRecentlyWarmed: false,
  });

  const got = await (await manage.request("/providers/codebuddy/auto-warmup")).json();
  expect(got.enabled).toBe(true);
  expect(got.intervalMinutes).toBe(30);
  expect(got.concurrency).toBe(4);

  // Scheduler cycle: account was never auto-warmed → due immediately.
  stub = (input) => {
    const url = typeof input === "string" ? input : input.url;
    if (url.includes("billing/meter")) return new Response(JSON.stringify(USAGE_BILLING), { status: 200 });
    return new Response(OK_SSE, { status: 200 });
  };
  const { autoWarmCycle } = await import("../src/lib/autowarm");
  const first = await autoWarmCycle();
  expect(first).toBe(1);

  // Second cycle right after: last-warm + 30m is in the future → nothing due.
  const second = await autoWarmCycle();
  expect(second).toBe(0);

  // Disable again so other tests aren't surprised by a background cycle.
  await manage.request("/providers/codebuddy/auto-warmup", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ enabled: false }),
  });
});

test("concurrency is clamped to 16 and nonsense values fall back to defaults", async () => {
  await manage.request("/providers/codebuddy/auto-warmup", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ concurrency: 999 }),
  });
  const cfg = await (await manage.request("/providers/codebuddy/auto-warmup")).json();
  expect(cfg.concurrency).toBe(16);
});

// ── Usage report (dashboard Token Usage card) ────────────────────

test("GET /api/stats/usage buckets by range and filters old rows out of 1d", async () => {
  // Seed an old row (~3 days back) + rely on the fresh rows from earlier tests.
  // created_at is unix seconds (drizzle timestamp mode).
  const old = Math.floor(Date.now() / 1000) - 3 * 24 * 3600;
  liveDb.exec(`
    INSERT INTO request_logs (created_at, provider, model, account_id, account_label, stream, source, status,
      prompt_tokens, completion_tokens, total_tokens)
    VALUES (${old}, 'codebuddy', 'old-model', 1, 'acc-1', 0, 'proxy', 'success', 1000, 500, 1500)
  `);

  const d1 = await (await manage.request("/stats/usage?range=1d")).json();
  expect(d1.range).toBe("1d");
  // The old row (1500 tokens, old-model) must NOT appear in the 1d window.
  expect(d1.models.every((m: { model: string }) => m.model !== "old-model")).toBe(true);
  expect(d1.buckets.length).toBeGreaterThan(0);
  expect(d1.total).toBeGreaterThan(0);
  expect(d1.prompt + d1.completion).toBe(d1.total);
  // Hourly bucket shape for 1d.
  const span = Math.max(...d1.buckets.map((b: { t: number }) => b.t)) - Math.min(...d1.buckets.map((b: { t: number }) => b.t));
  expect(span).toBeLessThan(24 * 3600_000 + 1);

  // 7d includes the old row.
  const d7 = await (await manage.request("/stats/usage?range=7d")).json();
  expect(d7.models.some((m: { model: string }) => m.model === "old-model")).toBe(true);
  expect(d7.total).toBeGreaterThanOrEqual(d1.total);

  // all = everything, monthly buckets.
  const dall = await (await manage.request("/stats/usage?range=all")).json();
  expect(dall.total).toBe(d7.total);

  // Unknown range falls back to 1d.
  const dq = await (await manage.request("/stats/usage?range=bogus")).json();
  expect(dq.range).toBe("1d");
});
