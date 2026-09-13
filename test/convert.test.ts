import { test, expect } from "bun:test";
import { toCanonical, toSSE, toCompletion, type OpenAIBody } from "../src/convert/openai";
import type { StreamEvent } from "../src/providers/types";

async function* gen(...evs: StreamEvent[]): AsyncGenerator<StreamEvent> {
  for (const e of evs) yield e;
}

// Reads an SSE Response back into the parsed data payloads.
async function payloads(resp: Response): Promise<unknown[]> {
  const text = await resp.text();
  return text
    .split("\n\n")
    .map((b) => b.replace(/^data: /, "").trim())
    .filter((b) => b.length > 0 && b !== "[DONE]")
    .map((b) => JSON.parse(b));
}

test("string content becomes a single text part", () => {
  const body: OpenAIBody = { model: "m", messages: [{ role: "user", content: "hi" }] };
  const req = toCanonical(body, "claude-opus-5");
  expect(req.model).toBe("claude-opus-5"); // the routed id, not the client's
  expect(req.messages[0]).toEqual({ role: "user", parts: [{ type: "text", text: "hi" }] });
  expect(req.stream).toBe(false);
});

test("an unknown role degrades to user rather than being dropped", () => {
  const req = toCanonical({ model: "m", messages: [{ role: "developer", content: "x" }] }, "m");
  expect(req.messages[0]!.role).toBe("user");
});

test("a data-url image becomes an image part", () => {
  const req = toCanonical(
    {
      model: "m",
      messages: [{ role: "user", content: [{ type: "text", text: "what" }, { type: "image_url", image_url: { url: "data:image/png;base64,QUJD" } }] }],
    },
    "m"
  );
  expect(req.messages[0]!.parts).toEqual([
    { type: "text", text: "what" },
    { type: "image", mimeType: "image/png", data: "QUJD" },
  ]);
});

test("a remote image url is dropped — there are no inline bytes to forward", () => {
  const req = toCanonical(
    { model: "m", messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "https://x/y.png" } }] }] },
    "m"
  );
  expect(req.messages[0]!.parts).toEqual([]);
});

test("tool calls and tool results are carried over", () => {
  const req = toCanonical(
    {
      model: "m",
      messages: [
        { role: "assistant", content: null, tool_calls: [{ id: "c1", function: { name: "read", arguments: '{"p":1}' } }] },
        { role: "tool", content: "result", tool_call_id: "c1" },
      ],
    },
    "m"
  );
  expect(req.messages[0]!.toolCalls).toEqual([{ id: "c1", name: "read", args: '{"p":1}' }]);
  expect(req.messages[1]!.toolCallId).toBe("c1");
});

test("max_completion_tokens is accepted alongside max_tokens", () => {
  expect(toCanonical({ model: "m", messages: [], max_tokens: 100 }, "m").maxTokens).toBe(100);
  expect(toCanonical({ model: "m", messages: [], max_completion_tokens: 200 }, "m").maxTokens).toBe(200);
});

test("the original body is kept for provider passthrough fields", () => {
  const body = { model: "m", messages: [], reasoning_effort: "high" } as OpenAIBody;
  expect(toCanonical(body, "m").raw).toBe(body);
});

test("the first SSE chunk announces the assistant role", async () => {
  const chunks = (await payloads(toSSE(gen({ text: "a" }, { text: "b" }), "m"))) as any[];
  expect(chunks[0].choices[0].delta.role).toBe("assistant");
  expect(chunks[1].choices[0].delta.role).toBeUndefined();
  expect(chunks.map((c) => c.choices[0].delta.content)).toEqual(["a", "b"]);
});

test("the SSE stream terminates with [DONE]", async () => {
  const text = await toSSE(gen({ text: "a" }), "m").text();
  expect(text.endsWith("data: [DONE]\n\n")).toBe(true);
});

test("SSE headers announce an event stream", () => {
  const resp = toSSE(gen({ text: "a" }), "m");
  expect(resp.headers.get("Content-Type")).toBe("text/event-stream; charset=utf-8");
  expect(resp.headers.get("Cache-Control")).toBe("no-cache");
});

test("all chunks share one completion id", async () => {
  const chunks = (await payloads(toSSE(gen({ text: "a" }, { text: "b" }, { finish: "stop" }), "m"))) as any[];
  expect(new Set(chunks.map((c) => c.id)).size).toBe(1);
  expect(chunks[0].id.startsWith("chatcmpl-")).toBe(true);
});

test("usage and finish_reason ride the chunk that carried them", async () => {
  const chunks = (await payloads(
    toSSE(gen({ text: "a" }, { finish: "stop", usage: { inputTokens: 10, outputTokens: 2, cacheRead: 5 } }), "m")
  )) as any[];
  expect(chunks[0].choices[0].finish_reason).toBeNull();
  const last = chunks.at(-1)!;
  expect(last.choices[0].finish_reason).toBe("stop");
  expect(last.usage).toEqual({
    prompt_tokens: 10,
    completion_tokens: 2,
    total_tokens: 12,
    prompt_tokens_details: { cached_tokens: 5 },
  });
});

test("tool-call deltas stay fragmented on the way out", async () => {
  const chunks = (await payloads(
    toSSE(
      gen(
        { toolCalls: [{ index: 0, id: "c1", name: "read", argsDelta: '{"pa' }] },
        { toolCalls: [{ index: 0, argsDelta: 'th":1}' }] }
      ),
      "m"
    )
  )) as any[];
  expect(chunks[0].choices[0].delta.tool_calls).toEqual([
    { index: 0, id: "c1", type: "function", function: { name: "read", arguments: '{"pa' } },
  ]);
  expect(chunks[1].choices[0].delta.tool_calls).toEqual([
    { index: 0, type: "function", function: { arguments: 'th":1}' } },
  ]);
});

test("a model reported mid-stream overrides the requested id", async () => {
  const chunks = (await payloads(toSSE(gen({ text: "a", model: "actual-model" }), "requested"))) as any[];
  expect(chunks[0].model).toBe("actual-model");
});

// The status line is long gone by the time the stream breaks, so the failure
// has to travel inside the stream.
test("a mid-stream failure is reported as an in-band error then [DONE]", async () => {
  async function* boom(): AsyncGenerator<StreamEvent> {
    yield { text: "a" };
    throw new Error("connection reset");
  }
  const text = await toSSE(boom(), "m").text();
  expect(text).toContain('"content":"a"');
  expect(text).toContain("connection reset");
  expect(text).toContain("upstream_error");
  expect(text.endsWith("data: [DONE]\n\n")).toBe(true);
});

test("toCompletion joins text and reports usage once", async () => {
  const resp = await toCompletion(
    gen({ text: "Hel" }, { text: "lo" }, { finish: "stop", usage: { inputTokens: 4, outputTokens: 2 } }),
    "m"
  );
  const body = (await resp.json()) as any;
  expect(body.object).toBe("chat.completion");
  expect(body.choices[0].message.content).toBe("Hello");
  expect(body.choices[0].finish_reason).toBe("stop");
  expect(body.usage).toEqual({ prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 });
});

// Reassembly happens only here: a non-streaming client needs whole JSON args.
test("toCompletion reassembles fragmented tool arguments in index order", async () => {
  const resp = await toCompletion(
    gen(
      { toolCalls: [{ index: 1, id: "c2", name: "write", argsDelta: '{"b' }] },
      { toolCalls: [{ index: 0, id: "c1", name: "read", argsDelta: '{"a' }] },
      { toolCalls: [{ index: 0, argsDelta: '":1}' }, { index: 1, argsDelta: '":2}' }] },
      { finish: "tool_calls" }
    ),
    "m"
  );
  const body = (await resp.json()) as any;
  expect(body.choices[0].message.tool_calls).toEqual([
    { id: "c1", type: "function", function: { name: "read", arguments: '{"a":1}' } },
    { id: "c2", type: "function", function: { name: "write", arguments: '{"b":2}' } },
  ]);
  expect(body.choices[0].finish_reason).toBe("tool_calls");
});

test("toCompletion reports null content when only tool calls came back", async () => {
  const resp = await toCompletion(gen({ toolCalls: [{ index: 0, id: "c1", name: "x", argsDelta: "{}" }] }), "m");
  const body = (await resp.json()) as any;
  expect(body.choices[0].message.content).toBeNull();
  // No explicit finish arrived, but tool calls did — infer tool_calls.
  expect(body.choices[0].finish_reason).toBe("tool_calls");
});

test("toCompletion keeps reasoning text separate from content", async () => {
  const resp = await toCompletion(gen({ reasoning: "thinking" }, { text: "answer" }), "m");
  const body = (await resp.json()) as any;
  expect(body.choices[0].message.reasoning_content).toBe("thinking");
  expect(body.choices[0].message.content).toBe("answer");
});

test("an empty stream still produces a well-formed completion", async () => {
  const body = (await (await toCompletion(gen(), "m")).json()) as any;
  expect(body.choices[0].message.content).toBeNull();
  expect(body.choices[0].finish_reason).toBe("stop");
});
