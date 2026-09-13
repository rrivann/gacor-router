// Parses OpenAI-on-the-wire chat responses (SSE + plain JSON) into normalized
// StreamEvents. Shared by every upstream that speaks OpenAI, so such providers
// differ only in how they build the request envelope.

import type { StreamEvent, Usage, ToolCallDelta, FinishReason } from "./types";

interface RawUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  // Cache metrics arrive in three shapes: flat Tencent/CodeBuddy fields
  // (prompt_cache_hit_tokens / prompt_cache_write_tokens), flat clone fields
  // (cache_read_input_tokens / cache_creation_input_tokens), or nested
  // prompt_tokens_details.cached_tokens (OpenAI o1+/4o). Accept all, then take
  // whichever is non-zero.
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  prompt_cache_hit_tokens?: number;
  prompt_cache_write_tokens?: number;
  cached_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
}

interface RawToolCall {
  index?: number;
  id?: string;
  function?: { name?: string; arguments?: string };
}

interface RawDelta {
  content?: string | null;
  // Reasoning text has no standard field name; these are the ones upstreams use.
  reasoning_content?: string | null;
  reasoning?: string | null;
  tool_calls?: RawToolCall[];
}

interface RawChunk {
  model?: string;
  choices?: { delta?: RawDelta; message?: RawDelta; finish_reason?: string | null }[];
  usage?: RawUsage;
}

const FINISH: Record<string, FinishReason> = {
  stop: "stop",
  length: "length",
  tool_calls: "tool_calls",
  function_call: "tool_calls",
  content_filter: "content_filter",
};

function firstNonZero(...vals: (number | undefined)[]): number {
  for (const v of vals) if (v) return v;
  return 0;
}

function readUsage(raw: RawUsage | undefined): Usage | undefined {
  if (!raw) return undefined;
  const cacheRead = firstNonZero(
    raw.cache_read_input_tokens,
    raw.prompt_cache_hit_tokens,
    raw.prompt_tokens_details?.cached_tokens,
    raw.cached_tokens
  );
  const cacheWrite = firstNonZero(raw.cache_creation_input_tokens, raw.prompt_cache_write_tokens);
  const inputTokens = raw.prompt_tokens ?? 0;
  const outputTokens = raw.completion_tokens ?? 0;
  if (!inputTokens && !outputTokens && !cacheRead && !cacheWrite) return undefined;
  const usage: Usage = { inputTokens, outputTokens };
  if (cacheRead) usage.cacheRead = cacheRead;
  if (cacheWrite) usage.cacheWrite = cacheWrite;
  return usage;
}

function readToolCalls(raw: RawToolCall[] | undefined): ToolCallDelta[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  return raw.map((t, i) => {
    const d: ToolCallDelta = { index: t.index ?? i };
    if (t.id) d.id = t.id;
    if (t.function?.name) d.name = t.function.name;
    if (t.function?.arguments) d.argsDelta = t.function.arguments;
    return d;
  });
}

// Turns one parsed chunk into an event, or undefined when it carries nothing
// (keepalive/role-only chunks). The final chunk often has usage with empty
// choices, so usage alone is enough to emit.
function toEvent(chunk: RawChunk, fromMessage = false): StreamEvent | undefined {
  const choice = chunk.choices?.[0];
  const delta = (fromMessage ? choice?.message : choice?.delta) ?? {};
  const ev: StreamEvent = {};

  if (delta.content) ev.text = delta.content;
  const reasoning = delta.reasoning_content ?? delta.reasoning;
  if (reasoning) ev.reasoning = reasoning;
  const tools = readToolCalls(delta.tool_calls);
  if (tools) ev.toolCalls = tools;
  const usage = readUsage(chunk.usage);
  if (usage) ev.usage = usage;
  const finish = choice?.finish_reason;
  if (finish) ev.finish = FINISH[finish] ?? "stop";
  if (chunk.model) ev.model = chunk.model;

  // `model` alone is metadata, not progress — don't emit for it.
  const hasPayload =
    ev.text !== undefined ||
    ev.reasoning !== undefined ||
    ev.toolCalls !== undefined ||
    ev.usage !== undefined ||
    ev.finish !== undefined;
  return hasPayload ? ev : undefined;
}

const DATA = "data:";

// Splits an SSE byte stream into `data:` payloads. Multi-line data fields are
// joined with "\n" per the SSE spec; comments (":" lines) and other fields are
// ignored. Stops at [DONE].
async function* dataPayloads(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let pending: string[] = [];

  const flush = (): string | undefined => {
    if (pending.length === 0) return undefined;
    const joined = pending.join("\n");
    pending = [];
    return joined;
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });

      // Normalize CRLF so the line split below handles both wire styles.
      let nl: number;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl).replace(/\r$/, "");
        buf = buf.slice(nl + 1);

        if (line === "") {
          const payload = flush();
          if (payload !== undefined) {
            if (payload.trim() === "[DONE]") return;
            yield payload;
          }
          continue;
        }
        if (line.startsWith(DATA)) pending.push(line.slice(DATA.length).replace(/^ /, ""));
      }
    }
    // Trailing bytes with no final newline.
    const tail = buf.replace(/\r$/, "");
    if (tail.startsWith(DATA)) pending.push(tail.slice(DATA.length).replace(/^ /, ""));
    const payload = flush();
    if (payload !== undefined && payload.trim() !== "[DONE]") yield payload;
  } finally {
    reader.cancel().catch(() => {});
  }
}

export async function* parseSSE(resp: Response): AsyncGenerator<StreamEvent> {
  if (!resp.body) return;
  for await (const payload of dataPayloads(resp.body)) {
    let chunk: RawChunk;
    try {
      chunk = JSON.parse(payload) as RawChunk;
    } catch {
      continue; // a malformed chunk shouldn't kill the whole stream
    }
    const ev = toEvent(chunk);
    if (ev) yield ev;
  }
}

// Non-streaming response: one event carrying the whole message.
export async function* parseJSON(resp: Response): AsyncGenerator<StreamEvent> {
  const text = await resp.text();
  let chunk: RawChunk;
  try {
    chunk = JSON.parse(text) as RawChunk;
  } catch {
    return;
  }
  const ev = toEvent(chunk, true);
  if (ev) yield ev;
}

export function parseResponse(resp: Response, streaming: boolean): AsyncGenerator<StreamEvent> {
  return streaming ? parseSSE(resp) : parseJSON(resp);
}
