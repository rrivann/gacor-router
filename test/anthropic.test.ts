import { test, expect } from "bun:test";
import {
  toAnthropicEvents,
  toAnthropicMessage,
  toAnthropicSSE,
  toAnthropicUsage,
  toCanonicalFromAnthropic,
  type AnthropicBody,
} from "../src/convert/anthropic";
import type { StreamEvent } from "../src/providers/types";

async function* gen(...evs: StreamEvent[]): AsyncGenerator<StreamEvent> {
  for (const e of evs) yield e;
}

async function events(...evs: StreamEvent[]): Promise<any[]> {
  const out: any[] = [];
  for await (const e of toAnthropicEvents(gen(...evs), "m")) out.push(e);
  return out;
}

function body(over: Partial<AnthropicBody> = {}): AnthropicBody {
  return { model: "m", messages: [], ...over };
}

// ── Request: Anthropic → canonical ───────────────────────────────

test("a string system prompt becomes the leading system message", () => {
  const req = toCanonicalFromAnthropic(
    body({ system: "be brief", messages: [{ role: "user", content: "hi" }] }),
    "claude-opus-5"
  );
  expect(req.model).toBe("claude-opus-5");
  expect(req.messages[0]).toEqual({ role: "system", parts: [{ type: "text", text: "be brief" }] });
  expect(req.messages[1]).toEqual({ role: "user", parts: [{ type: "text", text: "hi" }] });
});

test("an array system prompt joins its text blocks", () => {
  const req = toCanonicalFromAnthropic(
    body({ system: [{ type: "text", text: "a" }, { type: "text", text: "b" }] }),
    "m"
  );
  expect(req.messages[0]!.parts).toEqual([{ type: "text", text: "a\nb" }]);
});

test("an empty system prompt adds no message at all", () => {
  const req = toCanonicalFromAnthropic(body({ system: "" }), "m");
  expect(req.messages).toEqual([]);
});

// The spec says string | block[], but clients do send a bare block object.
test("a bare content block object is accepted like a one-element array", () => {
  const req = toCanonicalFromAnthropic(
    body({ messages: [{ role: "user", content: { type: "text", text: "hi" } as any }] }),
    "m"
  );
  expect(req.messages[0]!.parts).toEqual([{ type: "text", text: "hi" }]);
});

test("a base64 image block becomes an image part", () => {
  const req = toCanonicalFromAnthropic(
    body({
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "what" },
            { type: "image", source: { type: "base64", media_type: "image/png", data: "QUJD" } },
          ],
        },
      ],
    }),
    "m"
  );
  expect(req.messages[0]!.parts).toEqual([
    { type: "text", text: "what" },
    { type: "image", mimeType: "image/png", data: "QUJD" },
  ]);
});

test("a url image source is dropped — there are no inline bytes to forward", () => {
  const req = toCanonicalFromAnthropic(
    body({ messages: [{ role: "user", content: [{ type: "image", source: { type: "url", url: "https://x/y.png" } }] }] }),
    "m"
  );
  expect(req.messages).toEqual([]);
});

test("tool_use becomes a canonical tool call", () => {
  const req = toCanonicalFromAnthropic(
    body({
      messages: [
        { role: "assistant", content: [{ type: "tool_use", id: "tu1", name: "read", input: { path: "/x" } }] },
      ],
    }),
    "m"
  );
  expect(req.messages[0]!.role).toBe("assistant");
  expect(req.messages[0]!.toolCalls).toEqual([{ id: "tu1", name: "read", args: { path: "/x" } }]);
});

// Anthropic nests tool results in a user turn; the canonical form wants them
// standalone, so one message fans out into several.
test("tool_result becomes a standalone tool message, emitted before sibling text", () => {
  const req = toCanonicalFromAnthropic(
    body({
      messages: [
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "tu1", content: "42" },
            { type: "text", text: "thanks" },
          ],
        },
      ],
    }),
    "m"
  );
  expect(req.messages).toEqual([
    { role: "tool", parts: [{ type: "text", text: "42" }], toolCallId: "tu1" },
    { role: "user", parts: [{ type: "text", text: "thanks" }] },
  ]);
});

test("a tool_result carrying blocks joins their text", () => {
  const req = toCanonicalFromAnthropic(
    body({
      messages: [
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "t", content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] },
          ],
        },
      ],
    }),
    "m"
  );
  expect(req.messages[0]!.parts).toEqual([{ type: "text", text: "a\nb" }]);
});

// Dropping a non-text result would hide the tool's output from the model, so
// it is serialized instead.
test("a tool_result with no text blocks is serialized rather than dropped", () => {
  const req = toCanonicalFromAnthropic(
    body({
      messages: [
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "t", content: [{ type: "image", source: { data: "x" } }] }],
        },
      ],
    }),
    "m"
  );
  expect(req.messages[0]!.parts[0]!.text).toContain("image");
});

test("thinking blocks are dropped — their signatures don't survive the crossing", () => {
  const req = toCanonicalFromAnthropic(
    body({
      messages: [
        {
          role: "assistant",
          content: [
            { type: "thinking", text: "hmm" } as any,
            { type: "text", text: "answer" },
          ],
        },
      ],
    }),
    "m"
  );
  expect(req.messages[0]!.parts).toEqual([{ type: "text", text: "answer" }]);
});

test("tools cross over in the OpenAI shape providers build from", () => {
  const req = toCanonicalFromAnthropic(
    body({ tools: [{ name: "read", description: "reads", input_schema: { type: "object" } }] }),
    "m"
  );
  expect(req.tools).toEqual([
    { type: "function", function: { name: "read", description: "reads", parameters: { type: "object" } } },
  ]);
});

test("a tool with no schema still gets a valid empty one", () => {
  const req = toCanonicalFromAnthropic(body({ tools: [{ name: "x" }] }), "m");
  expect((req.tools![0] as any).function.parameters).toEqual({ type: "object", properties: {} });
});

test("server-side built-in tools are filtered out", () => {
  const req = toCanonicalFromAnthropic(
    body({ tools: [{ type: "web_search_20250305", name: "web_search" }, { name: "read" }] }),
    "m"
  );
  expect(req.tools).toHaveLength(1);
  expect((req.tools![0] as any).function.name).toBe("read");
});

test("tool_choice maps onto its OpenAI equivalent, including none", () => {
  const choice = (c: any) => (toCanonicalFromAnthropic(body({ tool_choice: c }), "m").raw as any).tool_choice;
  expect(choice({ type: "auto" })).toBe("auto");
  expect(choice({ type: "any" })).toBe("required");
  expect(choice({ type: "none" })).toBe("none");
  expect(choice({ type: "tool", name: "read" })).toEqual({ type: "function", function: { name: "read" } });
});

test("sampling params and stop sequences ride along in the raw body", () => {
  const req = toCanonicalFromAnthropic(
    body({ temperature: 0.4, top_p: 0.9, stop_sequences: ["END"], max_tokens: 512, stream: true }),
    "m"
  );
  expect(req.temperature).toBe(0.4);
  expect(req.maxTokens).toBe(512);
  expect(req.stream).toBe(true);
  expect((req.raw as any).top_p).toBe(0.9);
  expect((req.raw as any).stop).toEqual(["END"]);
});

// Providers read `raw` for passthrough fields and expect OpenAI keys there;
// handing them the Anthropic body would mis-translate tool_choice.
test("raw is rebuilt in the OpenAI shape, not the Anthropic one", () => {
  const req = toCanonicalFromAnthropic(body({ tool_choice: { type: "any" }, top_k: 5 }), "m");
  expect((req.raw as any).tool_choice).toBe("required");
  expect((req.raw as any).top_k).toBeUndefined();
});

// ── Usage arithmetic ─────────────────────────────────────────────

// Anthropic's input_tokens excludes cache; OpenAI's prompt_tokens includes it.
test("cached tokens are subtracted from input_tokens", () => {
  expect(toAnthropicUsage({ inputTokens: 100, outputTokens: 10, cacheRead: 30, cacheWrite: 20 })).toEqual({
    input_tokens: 50,
    output_tokens: 10,
    cache_read_input_tokens: 30,
    cache_creation_input_tokens: 20,
  });
});

test("cache fields are omitted when there is no cache activity", () => {
  expect(toAnthropicUsage({ inputTokens: 8, outputTokens: 2 })).toEqual({
    input_tokens: 8,
    output_tokens: 2,
  });
});

test("input_tokens never goes negative when cache counts exceed the prompt", () => {
  expect(toAnthropicUsage({ inputTokens: 10, outputTokens: 1, cacheRead: 40 }).input_tokens).toBe(0);
});

// ── Response: canonical → Anthropic SSE ──────────────────────────

test("the stream opens with message_start then ping", async () => {
  const evs = await events({ text: "hi" });
  expect(evs[0].type).toBe("message_start");
  expect(evs[0].message.role).toBe("assistant");
  expect(evs[0].message.id.startsWith("msg_")).toBe(true);
  expect(evs[1].type).toBe("ping");
});

test("the stream closes with message_delta then message_stop", async () => {
  const evs = await events({ text: "hi" }, { finish: "stop" });
  expect(evs.at(-2).type).toBe("message_delta");
  expect(evs.at(-2).delta).toEqual({ stop_reason: "end_turn", stop_sequence: null });
  expect(evs.at(-1).type).toBe("message_stop");
});

test("text deltas are wrapped in one content block", async () => {
  const evs = await events({ text: "a" }, { text: "b" }, { finish: "stop" });
  const blocks = evs.filter((e) => e.type.startsWith("content_block"));
  expect(blocks.map((b) => b.type)).toEqual([
    "content_block_start",
    "content_block_delta",
    "content_block_delta",
    "content_block_stop",
  ]);
  expect(blocks[0].content_block).toEqual({ type: "text", text: "" });
  expect(blocks[1].delta).toEqual({ type: "text_delta", text: "a" });
});

test("reasoning opens a thinking block that closes when text starts", async () => {
  const evs = await events({ reasoning: "hmm" }, { text: "answer" }, { finish: "stop" });
  const blocks = evs.filter((e) => e.type.startsWith("content_block"));
  expect(blocks[0]).toMatchObject({ type: "content_block_start", index: 0, content_block: { type: "thinking" } });
  expect(blocks[1].delta).toEqual({ type: "thinking_delta", thinking: "hmm" });
  expect(blocks[2]).toMatchObject({ type: "content_block_stop", index: 0 });
  expect(blocks[3]).toMatchObject({ type: "content_block_start", index: 1, content_block: { type: "text" } });
});

// Only one block may be open at a time, and indices are allocated in emission
// order — the mixed case is where index bookkeeping usually breaks.
test("thinking, text, and two tool calls get four sequential block indices", async () => {
  const evs = await events(
    { reasoning: "r" },
    { text: "t" },
    { toolCalls: [{ index: 0, id: "tu1", name: "read", argsDelta: "{}" }] },
    { toolCalls: [{ index: 1, id: "tu2", name: "write", argsDelta: "{}" }] },
    { finish: "tool_calls" }
  );
  const starts = evs.filter((e) => e.type === "content_block_start");
  expect(starts.map((s) => [s.index, s.content_block.type])).toEqual([
    [0, "thinking"],
    [1, "text"],
    [2, "tool_use"],
    [3, "tool_use"],
  ]);
  // Every opened block is closed exactly once.
  expect(evs.filter((e) => e.type === "content_block_stop").map((s) => s.index)).toEqual([0, 1, 2, 3]);
});

// Streaming the fragments is the entire point of input_json_delta; buffering
// them to the end would break progressive tool-argument rendering.
test("tool arguments stream as input_json_delta fragments", async () => {
  const evs = await events(
    { toolCalls: [{ index: 0, id: "tu1", name: "read", argsDelta: '{"pa' }] },
    { toolCalls: [{ index: 0, argsDelta: 'th":1}' }] },
    { finish: "tool_calls" }
  );
  const deltas = evs.filter((e) => e.type === "content_block_delta");
  expect(deltas.map((d) => d.delta.partial_json)).toEqual(['{"pa', 'th":1}']);
  expect(evs.filter((e) => e.type === "content_block_start")).toHaveLength(1);
});

test("usage rides message_delta with cache subtracted", async () => {
  const evs = await events(
    { text: "a" },
    { finish: "stop", usage: { inputTokens: 100, outputTokens: 5, cacheRead: 40 } }
  );
  expect(evs.at(-2).usage).toEqual({
    input_tokens: 60,
    output_tokens: 5,
    cache_read_input_tokens: 40,
  });
});

// finish_reason and usage often arrive in different chunks, so the terminal
// events wait for the stream to end rather than firing on finish.
test("usage arriving after finish_reason still reaches message_delta", async () => {
  const evs = await events(
    { text: "a" },
    { finish: "stop" },
    { usage: { inputTokens: 7, outputTokens: 3 } }
  );
  expect(evs.at(-2).usage).toEqual({ input_tokens: 7, output_tokens: 3 });
  expect(evs.at(-2).delta.stop_reason).toBe("end_turn");
});

test("finish reasons map onto Anthropic stop reasons", async () => {
  const reason = async (f: StreamEvent["finish"]) =>
    (await events({ text: "a" }, { finish: f })).at(-2).delta.stop_reason;
  expect(await reason("stop")).toBe("end_turn");
  expect(await reason("length")).toBe("max_tokens");
  expect(await reason("tool_calls")).toBe("tool_use");
  expect(await reason("content_filter")).toBe("refusal");
});

test("tool calls with no explicit finish still report tool_use", async () => {
  const evs = await events({ toolCalls: [{ index: 0, id: "t", name: "x", argsDelta: "{}" }] });
  expect(evs.at(-2).delta.stop_reason).toBe("tool_use");
});

test("an empty stream still produces a well-formed message envelope", async () => {
  const evs = await events();
  expect(evs.map((e) => e.type)).toEqual(["message_start", "ping", "message_delta", "message_stop"]);
  expect(evs.at(-2).delta.stop_reason).toBe("end_turn");
});

test("upstream model in a stream event does NOT override the caller-supplied id", async () => {
  // Anthropic clients (Claude Code) validate response.model against their
  // hardcoded whitelist. Leaking the upstream's canonical name would fail
  // that check even though the request succeeded. The caller-supplied id is
  // the source of truth for the /v1/messages envelope.
  const evs = await events({ text: "a", model: "actual-upstream-name" });
  expect(evs[0].message.model).toBe("m");
});

// The status line is long gone once the stream breaks, so the failure has to
// travel in-band — and any open block must still be closed.
test("a mid-stream failure closes the open block then emits an error event", async () => {
  async function* boom(): AsyncGenerator<StreamEvent> {
    yield { text: "a" };
    throw new Error("connection reset");
  }
  const out: any[] = [];
  for await (const e of toAnthropicEvents(boom(), "m")) out.push(e);
  expect(out.at(-2).type).toBe("content_block_stop");
  expect(out.at(-1)).toEqual({
    type: "error",
    error: { type: "api_error", message: "connection reset" },
  });
});

test("SSE frames name the event and announce an event stream", async () => {
  const resp = toAnthropicSSE(gen({ text: "hi" }, { finish: "stop" }), "m");
  expect(resp.headers.get("Content-Type")).toBe("text/event-stream; charset=utf-8");
  const text = await resp.text();
  expect(text.startsWith("event: message_start\ndata: {")).toBe(true);
  expect(text).toContain("event: content_block_delta\n");
  expect(text.trimEnd().endsWith('data: {"type":"message_stop"}')).toBe(true);
});

// ── Response: canonical → Anthropic Message ──────────────────────

test("toAnthropicMessage assembles one message with usage", async () => {
  const resp = await toAnthropicMessage(
    gen({ text: "Hel" }, { text: "lo" }, { finish: "stop", usage: { inputTokens: 4, outputTokens: 2 } }),
    "m"
  );
  const b = (await resp.json()) as any;
  expect(b.type).toBe("message");
  expect(b.role).toBe("assistant");
  expect(b.content).toEqual([{ type: "text", text: "Hello" }]);
  expect(b.stop_reason).toBe("end_turn");
  expect(b.stop_sequence).toBeNull();
  expect(b.usage).toEqual({ input_tokens: 4, output_tokens: 2 });
});

test("blocks are ordered thinking, text, then tool_use", async () => {
  const resp = await toAnthropicMessage(
    gen(
      { text: "answer" },
      { reasoning: "hmm" },
      { toolCalls: [{ index: 0, id: "tu1", name: "read", argsDelta: '{"p":1}' }] },
      { finish: "tool_calls" }
    ),
    "m"
  );
  const b = (await resp.json()) as any;
  expect(b.content).toEqual([
    { type: "thinking", thinking: "hmm" },
    { type: "text", text: "answer" },
    { type: "tool_use", id: "tu1", name: "read", input: { p: 1 } },
  ]);
  expect(b.stop_reason).toBe("tool_use");
});

test("fragmented tool arguments are reassembled in index order", async () => {
  const resp = await toAnthropicMessage(
    gen(
      { toolCalls: [{ index: 1, id: "t2", name: "write", argsDelta: '{"b' }] },
      { toolCalls: [{ index: 0, id: "t1", name: "read", argsDelta: '{"a' }] },
      { toolCalls: [{ index: 0, argsDelta: '":1}' }, { index: 1, argsDelta: '":2}' }] }
    ),
    "m"
  );
  const b = (await resp.json()) as any;
  expect(b.content.map((c: any) => [c.id, c.input])).toEqual([
    ["t1", { a: 1 }],
    ["t2", { b: 2 }],
  ]);
});

test("malformed tool arguments degrade to an empty input rather than failing", async () => {
  const resp = await toAnthropicMessage(
    gen({ toolCalls: [{ index: 0, id: "t", name: "x", argsDelta: '{"trunc' }] }),
    "m"
  );
  const b = (await resp.json()) as any;
  expect(b.content[0].input).toEqual({});
});

// The API rejects an empty content array, so a silent upstream still needs a block.
test("an empty stream still yields one text block", async () => {
  const b = (await (await toAnthropicMessage(gen(), "m")).json()) as any;
  expect(b.content).toEqual([{ type: "text", text: "" }]);
  expect(b.stop_reason).toBe("end_turn");
});
