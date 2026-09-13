import { test, expect } from "bun:test";
import { parseSSE, parseJSON } from "../src/providers/oaistream";
import type { StreamEvent } from "../src/providers/types";

function sse(text: string): Response {
  return new Response(text, { headers: { "Content-Type": "text/event-stream" } });
}

// Feeds the body in arbitrary slices so events must not depend on chunk
// boundaries — the real wire splits wherever it likes.
function chunked(text: string, size: number): Response {
  const bytes = new TextEncoder().encode(text);
  let i = 0;
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        if (i >= bytes.length) return controller.close();
        controller.enqueue(bytes.slice(i, i + size));
        i += size;
      },
    })
  );
}

async function collect(gen: AsyncGenerator<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

const BASIC =
  `data: {"model":"claude-opus-5","choices":[{"delta":{"role":"assistant"}}]}\n\n` +
  `data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n` +
  `data: {"choices":[{"delta":{"content":"lo"}}]}\n\n` +
  `data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":2}}\n\n` +
  `data: [DONE]\n\n`;

test("text deltas, finish and usage come through in order", async () => {
  const evs = await collect(parseSSE(sse(BASIC)));
  expect(evs.map((e) => e.text).filter(Boolean)).toEqual(["Hel", "lo"]);
  const last = evs.at(-1)!;
  expect(last.finish).toBe("stop");
  expect(last.usage).toEqual({ inputTokens: 10, outputTokens: 2 });
});

test("a role-only chunk emits nothing", async () => {
  const evs = await collect(parseSSE(sse(`data: {"choices":[{"delta":{"role":"assistant"}}]}\n\ndata: [DONE]\n\n`)));
  expect(evs).toEqual([]);
});

test("events do not depend on where the transport splits bytes", async () => {
  for (const size of [1, 3, 17, 64]) {
    const evs = await collect(parseSSE(chunked(BASIC, size)));
    expect(evs.map((e) => e.text).filter(Boolean).join("")).toBe("Hello");
    expect(evs.at(-1)!.usage?.inputTokens).toBe(10);
  }
});

test("CRLF line endings parse the same as LF", async () => {
  const evs = await collect(parseSSE(sse(BASIC.replace(/\n/g, "\r\n"))));
  expect(evs.map((e) => e.text).filter(Boolean).join("")).toBe("Hello");
});

test("anything after [DONE] is ignored", async () => {
  const body = `data: {"choices":[{"delta":{"content":"a"}}]}\n\ndata: [DONE]\n\ndata: {"choices":[{"delta":{"content":"b"}}]}\n\n`;
  const evs = await collect(parseSSE(sse(body)));
  expect(evs.map((e) => e.text)).toEqual(["a"]);
});

test("a malformed chunk is skipped without killing the stream", async () => {
  const body =
    `data: {"choices":[{"delta":{"content":"a"}}]}\n\n` +
    `data: {not json\n\n` +
    `data: {"choices":[{"delta":{"content":"b"}}]}\n\n` +
    `data: [DONE]\n\n`;
  const evs = await collect(parseSSE(sse(body)));
  expect(evs.map((e) => e.text)).toEqual(["a", "b"]);
});

test("SSE comments and non-data fields are ignored", async () => {
  const body = `: keepalive\nevent: message\ndata: {"choices":[{"delta":{"content":"a"}}]}\n\nid: 7\ndata: [DONE]\n\n`;
  const evs = await collect(parseSSE(sse(body)));
  expect(evs.map((e) => e.text)).toEqual(["a"]);
});

test("a multi-line data field is joined with newlines", async () => {
  const body = `data: {"choices":[{"delta":\ndata: {"content":"a"}}]}\n\ndata: [DONE]\n\n`;
  const evs = await collect(parseSSE(sse(body)));
  expect(evs.map((e) => e.text)).toEqual(["a"]);
});

test("a final chunk with no trailing newline is not lost", async () => {
  const evs = await collect(parseSSE(sse(`data: {"choices":[{"delta":{"content":"a"}}]}`)));
  expect(evs.map((e) => e.text)).toEqual(["a"]);
});

test("tool-call fragments pass through as deltas, unassembled", async () => {
  const body =
    `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"read","arguments":"{\\"pa"}}]}}]}\n\n` +
    `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"th\\":\\"/tmp\\"}"}}]}}]}\n\n` +
    `data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n` +
    `data: [DONE]\n\n`;
  const evs = await collect(parseSSE(sse(body)));
  expect(evs[0]!.toolCalls).toEqual([{ index: 0, id: "call_1", name: "read", argsDelta: '{"pa' }]);
  expect(evs[1]!.toolCalls).toEqual([{ index: 0, argsDelta: 'th":"/tmp"}' }]);
  expect(evs[2]!.finish).toBe("tool_calls");
});

test("a tool call without an explicit index falls back to array position", async () => {
  const body = `data: {"choices":[{"delta":{"tool_calls":[{"id":"a","function":{"name":"x"}},{"id":"b","function":{"name":"y"}}]}}]}\n\ndata: [DONE]\n\n`;
  const evs = await collect(parseSSE(sse(body)));
  expect(evs[0]!.toolCalls!.map((t) => t.index)).toEqual([0, 1]);
});

test("reasoning arrives under either field name", async () => {
  const a = await collect(parseSSE(sse(`data: {"choices":[{"delta":{"reasoning_content":"hmm"}}]}\n\ndata: [DONE]\n\n`)));
  expect(a[0]!.reasoning).toBe("hmm");
  const b = await collect(parseSSE(sse(`data: {"choices":[{"delta":{"reasoning":"hmm"}}]}\n\ndata: [DONE]\n\n`)));
  expect(b[0]!.reasoning).toBe("hmm");
});

test("finish_reason function_call maps onto tool_calls", async () => {
  const evs = await collect(parseSSE(sse(`data: {"choices":[{"delta":{},"finish_reason":"function_call"}]}\n\ndata: [DONE]\n\n`)));
  expect(evs[0]!.finish).toBe("tool_calls");
});

// Cache accounting differs per upstream; all three shapes must land on the same
// two fields, otherwise cached tokens silently read as zero.
test("cache tokens are read from the Tencent/CodeBuddy field names", async () => {
  const body = `data: {"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":1,"prompt_cache_hit_tokens":100,"prompt_cache_write_tokens":7}}\n\ndata: [DONE]\n\n`;
  const evs = await collect(parseSSE(sse(body)));
  expect(evs[0]!.usage).toEqual({ inputTokens: 5, outputTokens: 1, cacheRead: 100, cacheWrite: 7 });
});

test("cache tokens are read from the clone field names", async () => {
  const body = `data: {"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":1,"cache_read_input_tokens":50,"cache_creation_input_tokens":3}}\n\ndata: [DONE]\n\n`;
  const evs = await collect(parseSSE(sse(body)));
  expect(evs[0]!.usage).toEqual({ inputTokens: 5, outputTokens: 1, cacheRead: 50, cacheWrite: 3 });
});

test("cache tokens are read from the nested OpenAI shape", async () => {
  const body = `data: {"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":1,"prompt_tokens_details":{"cached_tokens":25}}}\n\ndata: [DONE]\n\n`;
  const evs = await collect(parseSSE(sse(body)));
  expect(evs[0]!.usage?.cacheRead).toBe(25);
});

test("an all-zero usage block is dropped rather than emitted", async () => {
  const body = `data: {"choices":[{"delta":{"content":"a"}}],"usage":{"prompt_tokens":0,"completion_tokens":0}}\n\ndata: [DONE]\n\n`;
  const evs = await collect(parseSSE(sse(body)));
  expect(evs[0]!.usage).toBeUndefined();
});

test("an empty body yields no events", async () => {
  expect(await collect(parseSSE(sse("")))).toEqual([]);
});

test("parseJSON reads a non-streaming completion from message, not delta", async () => {
  const body = JSON.stringify({
    model: "claude-opus-5",
    choices: [{ message: { content: "hello", tool_calls: [{ id: "c1", function: { name: "read", arguments: "{}" } }] }, finish_reason: "stop" }],
    usage: { prompt_tokens: 3, completion_tokens: 1 },
  });
  const evs = await collect(parseJSON(new Response(body)));
  expect(evs).toHaveLength(1);
  expect(evs[0]!.text).toBe("hello");
  expect(evs[0]!.finish).toBe("stop");
  expect(evs[0]!.toolCalls).toEqual([{ index: 0, id: "c1", name: "read", argsDelta: "{}" }]);
  expect(evs[0]!.usage).toEqual({ inputTokens: 3, outputTokens: 1 });
});

test("parseJSON on garbage yields nothing instead of throwing", async () => {
  expect(await collect(parseJSON(new Response("not json")))).toEqual([]);
});
