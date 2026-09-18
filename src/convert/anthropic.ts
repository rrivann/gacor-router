// Anthropic Messages wire format <-> canonical ChatRequest / StreamEvent.
//
// The canonical shape is OpenAI-flavoured (that's what every upstream here
// speaks), so this module is the bridge for Anthropic-native clients hitting
// POST /v1/messages.
//
// Two conventions differ between the formats and are handled explicitly:
//
//  1. Anthropic's `input_tokens` EXCLUDES cached tokens; OpenAI's
//     `prompt_tokens` INCLUDES them. Every crossing subtracts/adds the cache
//     counts so a cached request isn't double-counted.
//  2. Anthropic carries tool results inside a *user* message's content blocks,
//     while the canonical form (like OpenAI) uses a standalone `tool` message.
//     One Anthropic message can therefore fan out into several canonical ones.

import type {
  CanonicalMessage,
  ChatRequest,
  FinishReason,
  StreamEvent,
  Usage,
} from "../providers/types";

// ── Wire types ───────────────────────────────────────────────────

export interface AnthropicImageSource {
  type?: string;
  media_type?: string;
  data?: string;
  url?: string;
}

export interface AnthropicContentBlock {
  type?: string;
  text?: string;
  source?: AnthropicImageSource;
  // tool_use
  id?: string;
  name?: string;
  input?: unknown;
  // tool_result
  tool_use_id?: string;
  content?: string | AnthropicContentBlock[] | Record<string, unknown>;
  is_error?: boolean;
}

export interface AnthropicMessage {
  role?: string;
  content?: string | AnthropicContentBlock[] | AnthropicContentBlock | null;
}

export interface AnthropicTool {
  name?: string;
  description?: string;
  input_schema?: unknown;
  type?: string;
}

export type AnthropicToolChoice =
  | { type?: "auto" | "any" | "tool" | "none"; name?: string }
  | string;

export interface AnthropicBody {
  model: string;
  messages: AnthropicMessage[];
  system?: string | AnthropicContentBlock[];
  max_tokens?: number;
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  stop_sequences?: string[];
  tools?: AnthropicTool[];
  tool_choice?: AnthropicToolChoice;
  thinking?: { type?: string; budget_tokens?: number };
  metadata?: unknown;
}

// ── Request: Anthropic → canonical ───────────────────────────────

// `content` is documented as string | block[], but clients do send a bare
// block object. Normalize all three into an array without mutating the input.
function blocks(content: AnthropicMessage["content"]): AnthropicContentBlock[] {
  if (content === null || content === undefined) return [];
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (Array.isArray(content)) return content;
  return [content];
}

// Anthropic takes images as {type:"base64", media_type, data}; the url variant
// has no inline bytes, so only a data: URL survives the crossing.
function toImagePart(src: AnthropicImageSource | undefined): CanonicalMessage["parts"][number] | null {
  if (!src) return null;
  if (src.type === "base64" && src.data) {
    return { type: "image", mimeType: src.media_type ?? "image/png", data: src.data };
  }
  const m = src.url ? /^data:([^;,]+);base64,(.*)$/s.exec(src.url) : null;
  return m ? { type: "image", mimeType: m[1]!, data: m[2]! } : null;
}

// A tool_result's payload is string | block[] | object. Text blocks are joined;
// anything else is serialized so the information reaches the model verbatim
// rather than being dropped.
function toolResultText(block: AnthropicContentBlock): string {
  const c = block.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    const text = c
      .filter((b) => b?.type === "text")
      .map((b) => b.text ?? "")
      .join("\n");
    return text || JSON.stringify(c);
  }
  if (c && typeof c === "object") return JSON.stringify(c);
  return "";
}

function systemText(system: AnthropicBody["system"]): string {
  if (typeof system === "string") return system;
  if (!Array.isArray(system)) return "";
  return system
    .filter((b) => b?.type === undefined || b.type === "text")
    .map((b) => b.text ?? "")
    .filter(Boolean)
    .join("\n");
}

// Anthropic tools are flat {name, description, input_schema}; providers here
// build OpenAI-shaped requests, so tools cross over in that shape.
function toOpenAITools(tools: AnthropicTool[]): unknown[] {
  return tools
    // Server-side built-ins (web_search, computer_use, ...) have no schema to
    // forward and aren't executable by these upstreams.
    .filter((t) => t.type === undefined || t.type === "custom" || t.type === "function")
    .map((t) => ({
      type: "function",
      function: {
        name: t.name ?? "",
        description: t.description ?? "",
        parameters: t.input_schema ?? { type: "object", properties: {} },
      },
    }));
}

function toOpenAIToolChoice(choice: AnthropicToolChoice | undefined): unknown {
  if (choice === undefined) return undefined;
  if (typeof choice === "string") return choice;
  switch (choice.type) {
    case "any":
      return "required";
    case "none":
      return "none";
    case "tool":
      return choice.name ? { type: "function", function: { name: choice.name } } : "required";
    case "auto":
    default:
      return "auto";
  }
}

// Converts one Anthropic message into the canonical messages it implies.
// tool_result blocks become standalone `tool` messages and are emitted first,
// matching the order an OpenAI-shaped upstream expects.
function convertMessage(msg: AnthropicMessage): CanonicalMessage[] {
  const role: CanonicalMessage["role"] =
    msg.role === "assistant" ? "assistant" : msg.role === "system" ? "system" : "user";

  const parts: CanonicalMessage["parts"] = [];
  const toolCalls: NonNullable<CanonicalMessage["toolCalls"]> = [];
  const toolResults: CanonicalMessage[] = [];

  for (const block of blocks(msg.content)) {
    switch (block?.type) {
      case "text":
        if (block.text) parts.push({ type: "text", text: block.text });
        break;
      case "image": {
        const img = toImagePart(block.source);
        if (img) parts.push(img);
        break;
      }
      case "tool_use":
        toolCalls.push({
          id: block.id ?? `call_${toolCalls.length}`,
          name: block.name ?? "",
          args: block.input ?? {},
        });
        break;
      case "tool_result":
        toolResults.push({
          role: "tool",
          parts: [{ type: "text", text: toolResultText(block) }],
          toolCallId: block.tool_use_id ?? "",
        });
        break;
      // `thinking` / `redacted_thinking` are signed, Anthropic-specific
      // artifacts. Replaying them to a non-Anthropic upstream is meaningless
      // (and to Anthropic itself, invalid once the signature is foreign), so
      // they're dropped rather than forwarded.
      default:
        break;
    }
  }

  const out: CanonicalMessage[] = [...toolResults];
  if (parts.length > 0 || toolCalls.length > 0) {
    const m: CanonicalMessage = { role, parts };
    if (toolCalls.length > 0) m.toolCalls = toolCalls;
    out.push(m);
  }
  return out;
}

// Rebuilds the request as an OpenAI-shaped body. Providers read `raw` for
// passthrough fields (temperature, tool_choice, ...) and expect that shape —
// handing them the Anthropic body verbatim would mis-translate tool_choice.
function openAIRaw(body: AnthropicBody, model: string): Record<string, unknown> {
  const raw: Record<string, unknown> = { model, stream: body.stream === true };
  if (body.temperature !== undefined) raw.temperature = body.temperature;
  if (body.top_p !== undefined) raw.top_p = body.top_p;
  if (body.stop_sequences?.length) raw.stop = body.stop_sequences;
  const choice = toOpenAIToolChoice(body.tool_choice);
  if (choice !== undefined) raw.tool_choice = choice;
  // `top_k`, `metadata`, and `thinking.budget_tokens` have no OpenAI
  // equivalent (a token budget isn't an effort level), so they stop here.
  return raw;
}

export function toCanonicalFromAnthropic(body: AnthropicBody, model: string): ChatRequest {
  const messages: CanonicalMessage[] = [];

  const system = systemText(body.system);
  if (system) messages.push({ role: "system", parts: [{ type: "text", text: system }] });

  for (const msg of body.messages) messages.push(...convertMessage(msg));

  const req: ChatRequest = {
    model,
    messages,
    stream: body.stream === true,
    raw: openAIRaw(body, model),
  };
  if (body.tools?.length) {
    const tools = toOpenAITools(body.tools);
    if (tools.length > 0) req.tools = tools;
  }
  if (body.temperature !== undefined) req.temperature = body.temperature;
  if (typeof body.max_tokens === "number") req.maxTokens = body.max_tokens;
  return req;
}

// ── Response: canonical → Anthropic ──────────────────────────────

const STOP_REASON: Record<FinishReason, string> = {
  stop: "end_turn",
  length: "max_tokens",
  tool_calls: "tool_use",
  content_filter: "refusal",
};

export interface AnthropicUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

// OpenAI's prompt_tokens counts cached tokens; Anthropic's input_tokens does
// not. Subtract so a cache hit isn't billed twice on the way out.
export function toAnthropicUsage(u: Usage | undefined): AnthropicUsage {
  if (!u) return { input_tokens: 0, output_tokens: 0 };
  const cacheRead = u.cacheRead ?? 0;
  const cacheWrite = u.cacheWrite ?? 0;
  const out: AnthropicUsage = {
    input_tokens: Math.max(0, u.inputTokens - cacheRead - cacheWrite),
    output_tokens: u.outputTokens,
  };
  if (cacheRead) out.cache_read_input_tokens = cacheRead;
  if (cacheWrite) out.cache_creation_input_tokens = cacheWrite;
  return out;
}

export interface AnthropicEvent {
  type: string;
  [k: string]: unknown;
}

function messageId(): string {
  return `msg_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
}

type OpenKind = "thinking" | "text" | "tool";

// Streams canonical events as the Anthropic event sequence:
//
//   message_start → ping
//     (content_block_start → content_block_delta* → content_block_stop)*
//   message_delta → message_stop
//
// Exactly one content block is open at a time, as the real API does. Block
// indices are allocated on open, so a response mixing thinking, text, and
// several tool_use blocks numbers them in emission order.
//
// Terminal events are emitted after the source stream ends rather than on the
// finish event, because usage typically arrives in a later chunk than
// finish_reason — waiting means message_delta carries the complete counts.
export async function* toAnthropicEvents(
  events: AsyncGenerator<StreamEvent>,
  model: string
): AsyncGenerator<AnthropicEvent> {
  const id = messageId();
  let started = false;
  let seenModel = model;
  let nextIndex = 0;
  let open: { kind: OpenKind; index: number; toolIndex?: number } | null = null;
  // Tool-call index (upstream's numbering) → the block index it was given.
  const toolBlocks = new Map<number, number>();
  let usage: Usage | undefined;
  let finish: FinishReason | undefined;
  let sawToolCall = false;

  const start = (m?: string): AnthropicEvent[] => {
    if (started) return [];
    started = true;
    if (m) seenModel = m;
    return [
      {
        type: "message_start",
        message: {
          id,
          type: "message",
          role: "assistant",
          model: seenModel,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          // The input count isn't known until the upstream reports usage,
          // which it does at the end of the stream. Clients should read the
          // totals from message_delta; these are placeholders.
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      },
      { type: "ping" },
    ];
  };

  const close = (): AnthropicEvent[] => {
    if (!open) return [];
    const ev = { type: "content_block_stop", index: open.index };
    open = null;
    return [ev];
  };

  try {
    for await (const ev of events) {
      const out: AnthropicEvent[] = [];
      if (!started) out.push(...start(ev.model));
      // Deliberately DO NOT overwrite seenModel from upstream events —
    // Anthropic clients validate the response.model against their request
    // and their hardcoded whitelist. The caller passes the client-sent id
    // (e.g. "claude-opus-4-7[1m]") and we must echo that back unchanged.

      if (ev.reasoning) {
        if (open?.kind !== "thinking") {
          out.push(...close());
          open = { kind: "thinking", index: nextIndex++ };
          out.push({
            type: "content_block_start",
            index: open.index,
            content_block: { type: "thinking", thinking: "" },
          });
        }
        out.push({
          type: "content_block_delta",
          index: open.index,
          delta: { type: "thinking_delta", thinking: ev.reasoning },
        });
      }

      if (ev.text) {
        if (open?.kind !== "text") {
          out.push(...close());
          open = { kind: "text", index: nextIndex++ };
          out.push({
            type: "content_block_start",
            index: open.index,
            content_block: { type: "text", text: "" },
          });
        }
        out.push({
          type: "content_block_delta",
          index: open.index,
          delta: { type: "text_delta", text: ev.text },
        });
      }

      // Upstreams stream one tool call to completion before starting the next,
      // so switching tool index closes the previous block.
      for (const tc of ev.toolCalls ?? []) {
        sawToolCall = true;
        if (open?.kind !== "tool" || open.toolIndex !== tc.index) {
          out.push(...close());
          const index = toolBlocks.get(tc.index) ?? nextIndex++;
          toolBlocks.set(tc.index, index);
          open = { kind: "tool", index, toolIndex: tc.index };
          out.push({
            type: "content_block_start",
            index,
            content_block: {
              type: "tool_use",
              id: tc.id ?? `toolu_${tc.index}`,
              name: tc.name ?? "",
              input: {},
            },
          });
        }
        // Forwarded as it arrives so clients can render arguments while they
        // stream, which is the whole point of input_json_delta.
        if (tc.argsDelta) {
          out.push({
            type: "content_block_delta",
            index: open.index,
            delta: { type: "input_json_delta", partial_json: tc.argsDelta },
          });
        }
      }

      if (ev.usage) usage = ev.usage;
      if (ev.finish) finish = ev.finish;

      for (const e of out) yield e;
    }
  } catch (err) {
    // Headers are long gone by now, so the failure travels in-band.
    if (!started) for (const e of start()) yield e;
    for (const e of close()) yield e;
    yield {
      type: "error",
      error: { type: "api_error", message: err instanceof Error ? err.message : String(err) },
    };
    return;
  }

  if (!started) for (const e of start()) yield e;
  for (const e of close()) yield e;

  const reason = finish ?? (sawToolCall ? "tool_calls" : "stop");
  yield {
    type: "message_delta",
    delta: { stop_reason: STOP_REASON[reason] ?? "end_turn", stop_sequence: null },
    usage: toAnthropicUsage(usage),
  };
  yield { type: "message_stop" };
}

// Anthropic names its SSE events; the event name mirrors the payload's type.
export function toAnthropicSSE(events: AsyncGenerator<StreamEvent>, model: string): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const ev of toAnthropicEvents(events, model)) {
          controller.enqueue(encoder.encode(`event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`));
        }
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        controller.enqueue(
          encoder.encode(
            `event: error\ndata: ${JSON.stringify({ type: "error", error: { type: "api_error", message } })}\n\n`
          )
        );
      }
      controller.close();
    },
  });

  return new Response(body, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

function parseArgs(args: string): unknown {
  if (!args) return {};
  try {
    return JSON.parse(args);
  } catch {
    // A truncated or malformed fragment shouldn't fail the response; the
    // client sees an empty input rather than invalid JSON.
    return {};
  }
}

// Non-streaming: drain the stream into a single Message. Blocks are ordered
// thinking → text → tool_use, and `content` is never empty (the API rejects
// an empty array).
export async function toAnthropicMessage(
  events: AsyncGenerator<StreamEvent>,
  model: string
): Promise<Response> {
  let text = "";
  let reasoning = "";
  let seenModel = model;
  let finish: FinishReason | undefined;
  let usage: Usage | undefined;
  const tools = new Map<number, { id: string; name: string; args: string }>();

  for await (const ev of events) {
    if (ev.text) text += ev.text;
    if (ev.reasoning) reasoning += ev.reasoning;
    // Deliberately DO NOT overwrite seenModel from upstream events —
    // Anthropic clients validate the response.model against their request
    // and their hardcoded whitelist. The caller passes the client-sent id
    // (e.g. "claude-opus-4-7[1m]") and we must echo that back unchanged.
    if (ev.finish) finish = ev.finish;
    if (ev.usage) usage = ev.usage;
    for (const tc of ev.toolCalls ?? []) {
      const cur = tools.get(tc.index) ?? { id: "", name: "", args: "" };
      if (tc.id) cur.id = tc.id;
      if (tc.name) cur.name = tc.name;
      if (tc.argsDelta) cur.args += tc.argsDelta;
      tools.set(tc.index, cur);
    }
  }

  const content: Record<string, unknown>[] = [];
  if (reasoning) content.push({ type: "thinking", thinking: reasoning });
  if (text) content.push({ type: "text", text });
  for (const [index, t] of [...tools.entries()].sort(([a], [b]) => a - b)) {
    content.push({
      type: "tool_use",
      id: t.id || `toolu_${index}`,
      name: t.name,
      input: parseArgs(t.args),
    });
  }
  if (content.length === 0) content.push({ type: "text", text: "" });

  const reason = finish ?? (tools.size > 0 ? "tool_calls" : "stop");
  return Response.json({
    id: messageId(),
    type: "message",
    role: "assistant",
    model: seenModel,
    content,
    stop_reason: STOP_REASON[reason] ?? "end_turn",
    stop_sequence: null,
    usage: toAnthropicUsage(usage),
  });
}
