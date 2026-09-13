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
    status text default 'active' not null, created_at integer not null);
  CREATE TABLE settings (key text primary key, value text not null);
  INSERT INTO accounts (provider,label,secret,status,created_at)
    VALUES ('codebuddy','acc-1','token-1','active',0);
`);

const { api } = await import("../src/api");
const { setSetting } = await import("../src/db/accounts");

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

const OK_SSE = `data: {"choices":[{"delta":{"content":"hello"}}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":1}}\n\ndata: [DONE]\n\n`;

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
