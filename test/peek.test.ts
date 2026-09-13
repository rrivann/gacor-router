// peekError decides whether a 200 is a real stream or a disguised error. The
// stream case must come back byte-identical — a lost first chunk would silently
// truncate every reply.

import { test, expect } from "bun:test";
import { peekError, isAppError } from "../src/providers/peek";

function streamOf(text: string, size: number): Response {
  const bytes = new TextEncoder().encode(text);
  let i = 0;
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        if (i >= bytes.length) return controller.close();
        controller.enqueue(bytes.slice(i, i + size));
        i += size;
      },
    }),
    { status: 200, headers: { "Content-Type": "text/event-stream" } }
  );
}

test("a 200 carrying a JSON error envelope is reported as an error", async () => {
  const body = `{"code":11101,"msg":"system message required","requestId":"x"}`;
  const r = await peekError(new Response(body, { status: 200 }));
  expect(r.errorBody).toBe(body);
  expect(r.response).toBeUndefined();
});

test("a JSON envelope with an error field is reported as an error", async () => {
  const body = `{"error":{"message":"bad token"}}`;
  const r = await peekError(new Response(body, { status: 401 }));
  expect(r.errorBody).toBe(body);
});

test("an SSE stream is handed back complete, first chunk included", async () => {
  const sse = `data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n`;
  for (const size of [1, 5, 4096]) {
    const r = await peekError(streamOf(sse, size));
    expect(r.errorBody).toBeUndefined();
    expect(await r.response!.text()).toBe(sse);
  }
});

test("an event:-prefixed stream is also passed through", async () => {
  const sse = `event: message\ndata: {"choices":[]}\n\n`;
  const r = await peekError(new Response(sse, { status: 200 }));
  expect(await r.response!.text()).toBe(sse);
});

test("leading whitespace before the JSON is still detected as an error", async () => {
  const r = await peekError(new Response(`\n\n  {"code":500,"msg":"x"}`, { status: 200 }));
  expect(r.errorBody).toBe(`{"code":500,"msg":"x"}`);
});

test("an empty 200 body is malformed, not a stream", async () => {
  const r = await peekError(new Response("", { status: 200 }));
  expect(r.errorBody).toBe("");
  expect(r.response).toBeUndefined();
});

test("a whitespace-only body is malformed too", async () => {
  const r = await peekError(new Response("\n   \n", { status: 200 }));
  expect(r.errorBody).toBe("");
});

test("a non-streaming JSON completion passes through to the JSON parser", async () => {
  // Valid JSON, no error markers — this is a real answer, not a failure.
  const body = JSON.stringify({ choices: [{ message: { content: "hi" } }] });
  const r = await peekError(new Response(body, { status: 200 }));
  expect(r.errorBody).toBeUndefined();
  expect(await r.response!.text()).toBe(body);
});

test("the rebuilt response keeps status and headers", async () => {
  const r = await peekError(streamOf("data: {}\n\n", 3));
  expect(r.response!.status).toBe(200);
  expect(r.response!.headers.get("Content-Type")).toBe("text/event-stream");
});

test("isAppError distinguishes an error envelope from a completion", () => {
  expect(isAppError(`{"code":11101,"msg":"x"}`)).toBe(true);
  expect(isAppError(`{"error":"boom"}`)).toBe(true);
  expect(isAppError(`{"code":0,"data":{}}`)).toBe(false); // code 0 means success
  expect(isAppError(`{"choices":[]}`)).toBe(false);
  expect(isAppError(`{"error":null}`)).toBe(false);
  expect(isAppError("not json")).toBe(false);
});

test("a multibyte body split mid-character is decoded intact", async () => {
  // "日本語" in an error message: the peek must not corrupt a split UTF-8 rune.
  const body = `{"code":11101,"msg":"日本語テスト"}`;
  const r = await peekError(streamOf(body, 2));
  expect(r.errorBody).toBe(body);
});
