// The request envelope is what CodeBuddy actually validates, so assert on the
// bytes and headers that go over the wire.

import { test, expect } from "bun:test";
import { gunzipSync } from "node:zlib";
import { CodeBuddyProvider } from "../src/providers/codebuddy";
import type { Account, ChatRequest } from "../src/providers/types";

const p = new CodeBuddyProvider();

const acc = (over: Partial<Account> = {}): Account => ({
  id: 1,
  label: "acc-1",
  secret: "",
  creds: {},
  ...over,
});

const req = (over: Partial<ChatRequest> = {}): ChatRequest => ({
  model: "claude-opus-5",
  messages: [{ role: "user", parts: [{ type: "text", text: "hi" }] }],
  stream: true,
  ...over,
});

async function sentBody(r: Request): Promise<Record<string, any>> {
  const gz = new Uint8Array(await r.arrayBuffer());
  return JSON.parse(gunzipSync(gz).toString("utf8"));
}

test("body is gzipped and declares the encoding", async () => {
  const r = await p.buildRequest(req(), acc({ secret: "t" }));
  expect(r.headers.get("Content-Encoding")).toBe("gzip");
  const raw = new Uint8Array(await r.clone().arrayBuffer());
  expect(raw[0]).toBe(0x1f); // gzip magic
  expect(raw[1]).toBe(0x8b);
  const body = await sentBody(r);
  expect(body.model).toBe("claude-opus-5");
});

test("posts to the CodeBuddy endpoint with CLI identifiers", async () => {
  const r = await p.buildRequest(req(), acc({ secret: "t" }));
  expect(r.url).toBe("https://www.codebuddy.ai/v2/chat/completions");
  expect(r.method).toBe("POST");
  expect(r.headers.get("User-Agent")).toBe("CLI/2.108.1 CodeBuddy/2.108.1");
  expect(r.headers.get("X-Domain")).toBe("www.codebuddy.ai");
  expect(r.headers.get("x-codebuddy-request")).toBe("1");
  expect(r.headers.get("X-Agent-Intent")).toBe("craft");
  expect(r.headers.get("X-Ide-Version")).toBe("2.108.1");
});

test("request ids are per-request, not reused", async () => {
  const a = await p.buildRequest(req(), acc({ secret: "t" }));
  const b = await p.buildRequest(req(), acc({ secret: "t" }));
  expect(a.headers.get("X-Request-ID")).not.toBe(b.headers.get("X-Request-ID"));
  expect(a.headers.get("X-Conversation-ID")).not.toBe(b.headers.get("X-Conversation-ID"));
  // Within one request, message id mirrors the request id.
  expect(a.headers.get("X-Conversation-Message-ID")).toBe(a.headers.get("X-Request-ID"));
});

test("token comes from access_token, then api_key, then secret", async () => {
  const withAccess = await p.buildRequest(req(), acc({ creds: { access_token: "A", api_key: "K" }, secret: "S" }));
  expect(withAccess.headers.get("Authorization")).toBe("Bearer A");

  const withApiKey = await p.buildRequest(req(), acc({ creds: { api_key: "K" }, secret: "S" }));
  expect(withApiKey.headers.get("Authorization")).toBe("Bearer K");

  const withSecret = await p.buildRequest(req(), acc({ secret: "S" }));
  expect(withSecret.headers.get("Authorization")).toBe("Bearer S");
});

test("a leading system message is injected when absent (code 11128)", async () => {
  const body = await sentBody(await p.buildRequest(req(), acc({ secret: "t" })));
  expect(body.messages[0].role).toBe("system");
  expect(body.messages[0].content.length).toBeGreaterThan(0); // 11133: never empty
  expect(body.messages[1].content).toBe("hi");
});

test("a system message not in first position is still fronted", async () => {
  // 9Router only checked whether *any* system message existed; the upstream
  // requires it first, so a trailing one must not satisfy the check.
  const r = req({
    messages: [
      { role: "user", parts: [{ type: "text", text: "hi" }] },
      { role: "system", parts: [{ type: "text", text: "be terse" }] },
    ],
  });
  const body = await sentBody(await p.buildRequest(r, acc({ secret: "t" })));
  expect(body.messages[0].role).toBe("system");
  expect(body.messages).toHaveLength(3);
});

test("an existing leading system message is left alone", async () => {
  const r = req({
    messages: [
      { role: "system", parts: [{ type: "text", text: "be terse" }] },
      { role: "user", parts: [{ type: "text", text: "hi" }] },
    ],
  });
  const body = await sentBody(await p.buildRequest(r, acc({ secret: "t" })));
  expect(body.messages).toHaveLength(2);
  expect(body.messages[0].content).toBe("be terse");
});

test("stream is forced true even for a non-streaming client", async () => {
  const body = await sentBody(await p.buildRequest(req({ stream: false }), acc({ secret: "t" })));
  expect(body.stream).toBe(true);
});

test("object tool_choice collapses to \"required\"", async () => {
  const r = req({ raw: { tool_choice: { type: "function", function: { name: "read" } } } });
  const body = await sentBody(await p.buildRequest(r, acc({ secret: "t" })));
  expect(body.tool_choice).toBe("required");
});

test("string tool_choice passes through", async () => {
  const r = req({ raw: { tool_choice: "auto" } });
  const body = await sentBody(await p.buildRequest(r, acc({ secret: "t" })));
  expect(body.tool_choice).toBe("auto");
});

test("reasoning_effort is passthrough-only, never defaulted", async () => {
  const bare = await sentBody(await p.buildRequest(req(), acc({ secret: "t" })));
  expect(bare.reasoning_effort).toBeUndefined();
  expect(bare.reasoning).toBeUndefined();

  const asked = req({ raw: { reasoning_effort: "high" } });
  const body = await sentBody(await p.buildRequest(asked, acc({ secret: "t" })));
  expect(body.reasoning_effort).toBe("high");
});

test("max_tokens is floored at 16", async () => {
  const low = await sentBody(await p.buildRequest(req({ maxTokens: 4 }), acc({ secret: "t" })));
  expect(low.max_tokens).toBe(16);
  const high = await sentBody(await p.buildRequest(req({ maxTokens: 8000 }), acc({ secret: "t" })));
  expect(high.max_tokens).toBe(8000);
});

test("tool and schema descriptions are truncated in the middle", async () => {
  const longTool = "T".repeat(3000);
  const longSchema = "S".repeat(2000);
  const r = req({
    tools: [
      {
        type: "function",
        function: {
          name: "read",
          description: longTool,
          parameters: { type: "object", properties: { path: { type: "string", description: longSchema } } },
        },
      },
    ],
  });
  const body = await sentBody(await p.buildRequest(r, acc({ secret: "t" })));
  const fn = body.tools[0].function;
  expect(fn.description.length).toBeLessThanOrEqual(1200);
  expect(fn.description).toContain("tool description truncated");
  expect(fn.description.startsWith("T")).toBe(true);
  expect(fn.description.endsWith("T")).toBe(true);
  const desc = fn.parameters.properties.path.description;
  expect(desc.length).toBeLessThanOrEqual(500);
  expect(desc).toContain("schema description truncated");
  expect(fn.name).toBe("read");
});

test("short descriptions are untouched", async () => {
  const r = req({ tools: [{ type: "function", function: { name: "ls", description: "list files", parameters: {} } }] });
  const body = await sentBody(await p.buildRequest(r, acc({ secret: "t" })));
  expect(body.tools[0].function.description).toBe("list files");
});

test("a self-referential schema is broken so the body stays serializable", async () => {
  const node: Record<string, unknown> = { type: "object" };
  node.properties = { child: node }; // cycle
  const r = req({ tools: [{ type: "function", function: { name: "tree", description: "d", parameters: node } }] });
  const body = await sentBody(await p.buildRequest(r, acc({ secret: "t" })));
  const params = body.tools[0].function.parameters;
  expect(params.type).toBe("object");
  expect(params.properties.child).toEqual({}); // cycle cut here
});

test("a schema shared by two siblings is kept, not mistaken for a cycle", async () => {
  const shared = { type: "string", description: "a path" };
  const params = { type: "object", properties: { from: shared, to: shared } };
  const r = req({ tools: [{ type: "function", function: { name: "mv", description: "d", parameters: params } }] });
  const body = await sentBody(await p.buildRequest(r, acc({ secret: "t" })));
  const props = body.tools[0].function.parameters.properties;
  expect(props.from).toEqual({ type: "string", description: "a path" });
  expect(props.to).toEqual({ type: "string", description: "a path" });
});

test("image parts become data-url image_url content", async () => {
  const r = req({
    messages: [
      { role: "user", parts: [{ type: "text", text: "what's this" }, { type: "image", mimeType: "image/jpeg", data: "QUJD" }] },
    ],
  });
  const body = await sentBody(await p.buildRequest(r, acc({ secret: "t" })));
  const content = body.messages[1].content;
  expect(content[0]).toEqual({ type: "text", text: "what's this" });
  expect(content[1].image_url.url).toBe("data:image/jpeg;base64,QUJD");
});

test("assistant tool calls and tool results survive the round trip", async () => {
  const r = req({
    messages: [
      { role: "assistant", parts: [], toolCalls: [{ id: "call_1", name: "read", args: { path: "/tmp/a" } }] },
      { role: "tool", parts: [{ type: "text", text: "contents" }], toolCallId: "call_1" },
    ],
  });
  const body = await sentBody(await p.buildRequest(r, acc({ secret: "t" })));
  expect(body.messages[1].tool_calls[0]).toEqual({
    index: 0,
    id: "call_1",
    type: "function",
    function: { name: "read", arguments: '{"path":"/tmp/a"}' },
  });
  expect(body.messages[2].tool_call_id).toBe("call_1");
});

test("the model catalogue is namespaced and non-empty", () => {
  const models = p.models();
  expect(models.length).toBe(30);
  expect(models.map((m) => m.id)).toContain("claude-opus-5");
  expect(models.every((m) => m.id.length > 0)).toBe(true);
});
