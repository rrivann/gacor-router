// OpenAI wire format <-> canonical ChatRequest / StreamEvent.
// Both the client and CodeBuddy speak OpenAI, so this is the only converter
// needed for now; Anthropic follows later.

import type { CanonicalMessage, ChatRequest, StreamEvent } from "../providers/types";

interface OpenAIContentPart {
  type?: string;
  text?: string;
  image_url?: { url?: string };
}

interface OpenAIMessage {
  role?: string;
  content?: string | OpenAIContentPart[] | null;
  tool_calls?: { id?: string; function?: { name?: string; arguments?: string } }[];
  tool_call_id?: string;
}

export interface OpenAIBody {
  model: string;
  messages: OpenAIMessage[];
  stream?: boolean;
  tools?: unknown[];
  max_tokens?: number;
  max_completion_tokens?: number;
  temperature?: number;
}

const ROLES = new Set(["system", "user", "assistant", "tool"]);

// data: URLs carry the mime type and payload we need; a plain http(s) URL has
// no inline bytes, so it is dropped rather than fetched.
function parseDataUrl(url: string): { mimeType: string; data: string } | null {
  const m = /^data:([^;,]+);base64,(.*)$/s.exec(url);
  return m ? { mimeType: m[1]!, data: m[2]! } : null;
}

function toParts(content: OpenAIMessage["content"]): CanonicalMessage["parts"] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (!Array.isArray(content)) return [];

  const parts: CanonicalMessage["parts"] = [];
  for (const p of content) {
    if (p?.type === "image_url" && p.image_url?.url) {
      const img = parseDataUrl(p.image_url.url);
      if (img) parts.push({ type: "image", mimeType: img.mimeType, data: img.data });
      continue;
    }
    if (typeof p?.text === "string") parts.push({ type: "text", text: p.text });
  }
  return parts;
}

export function toCanonical(body: OpenAIBody, model: string): ChatRequest {
  const messages: CanonicalMessage[] = body.messages.map((m) => {
    const role = ROLES.has(m.role ?? "") ? (m.role as CanonicalMessage["role"]) : "user";
    const msg: CanonicalMessage = { role, parts: toParts(m.content) };
    if (m.tool_calls?.length) {
      msg.toolCalls = m.tool_calls.map((tc, i) => ({
        id: tc.id ?? `call_${i}`,
        name: tc.function?.name ?? "",
        args: tc.function?.arguments ?? "",
      }));
    }
    if (m.tool_call_id) msg.toolCallId = m.tool_call_id;
    return msg;
  });

  const req: ChatRequest = {
    model,
    messages,
    stream: body.stream === true,
    raw: body,
  };
  if (Array.isArray(body.tools)) req.tools = body.tools;
  if (body.temperature !== undefined) req.temperature = body.temperature;
  const maxTokens = body.max_tokens ?? body.max_completion_tokens;
  if (typeof maxTokens === "number") req.maxTokens = maxTokens;
  return req;
}

function chunkId(): string {
  return `chatcmpl-${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
}

interface Delta {
  role?: "assistant";
  content?: string;
  reasoning_content?: string;
  tool_calls?: {
    index: number;
    id?: string;
    type?: "function";
    function?: { name?: string; arguments?: string };
  }[];
}

function toDelta(ev: StreamEvent): Delta | undefined {
  const delta: Delta = {};
  if (ev.text !== undefined) delta.content = ev.text;
  if (ev.reasoning !== undefined) delta.reasoning_content = ev.reasoning;
  if (ev.toolCalls) {
    delta.tool_calls = ev.toolCalls.map((tc) => {
      const out: NonNullable<Delta["tool_calls"]>[number] = { index: tc.index };
      if (tc.id) out.id = tc.id;
      if (tc.name || tc.argsDelta !== undefined) {
        out.type = "function";
        out.function = {};
        if (tc.name) out.function.name = tc.name;
        if (tc.argsDelta !== undefined) out.function.arguments = tc.argsDelta;
      }
      return out;
    });
  }
  return Object.keys(delta).length > 0 ? delta : undefined;
}

function usageBlock(ev: StreamEvent) {
  if (!ev.usage) return undefined;
  const u = ev.usage;
  const block: Record<string, unknown> = {
    prompt_tokens: u.inputTokens,
    completion_tokens: u.outputTokens,
    total_tokens: u.inputTokens + u.outputTokens,
  };
  if (u.cacheRead) block.prompt_tokens_details = { cached_tokens: u.cacheRead };
  return block;
}

// Streaming response: relay each event as an OpenAI chunk, then [DONE].
export function toSSE(events: AsyncGenerator<StreamEvent>, model: string): Response {
  const id = chunkId();
  const created = Math.floor(Date.now() / 1000);
  const encoder = new TextEncoder();

  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (obj: unknown) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
      let first = true;
      try {
        for await (const ev of events) {
          const delta = toDelta(ev) ?? {};
          if (first) {
            delta.role = "assistant";
            first = false;
          }
          const chunk: Record<string, unknown> = {
            id,
            object: "chat.completion.chunk",
            created,
            model: ev.model ?? model,
            choices: [{ index: 0, delta, finish_reason: ev.finish ?? null }],
          };
          const usage = usageBlock(ev);
          if (usage) chunk.usage = usage;
          send(chunk);
        }
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      } catch (e) {
        // The response headers are already sent, so surface the failure inside
        // the stream — that's the only channel left.
        send({ error: { message: e instanceof Error ? e.message : String(e), type: "upstream_error" } });
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      }
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

// Non-streaming response: drain the stream and assemble one completion.
// Tool-call argument fragments are concatenated per index here — the only place
// reassembly is unavoidable.
export async function toCompletion(events: AsyncGenerator<StreamEvent>, model: string): Promise<Response> {
  let text = "";
  let reasoning = "";
  let finish: string | null = null;
  let usage: ReturnType<typeof usageBlock>;
  let seenModel = model;
  const tools = new Map<number, { id: string; name: string; args: string }>();

  for await (const ev of events) {
    if (ev.text) text += ev.text;
    if (ev.reasoning) reasoning += ev.reasoning;
    if (ev.model) seenModel = ev.model;
    if (ev.finish) finish = ev.finish;
    const u = usageBlock(ev);
    if (u) usage = u;
    for (const tc of ev.toolCalls ?? []) {
      const cur = tools.get(tc.index) ?? { id: "", name: "", args: "" };
      if (tc.id) cur.id = tc.id;
      if (tc.name) cur.name = tc.name;
      if (tc.argsDelta) cur.args += tc.argsDelta;
      tools.set(tc.index, cur);
    }
  }

  const message: Record<string, unknown> = { role: "assistant", content: text || null };
  if (reasoning) message.reasoning_content = reasoning;
  if (tools.size > 0) {
    message.tool_calls = [...tools.entries()]
      .sort(([a], [b]) => a - b)
      .map(([index, t]) => ({
        id: t.id || `call_${index}`,
        type: "function",
        function: { name: t.name, arguments: t.args },
      }));
  }

  const payload: Record<string, unknown> = {
    id: chunkId(),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: seenModel,
    choices: [{ index: 0, message, finish_reason: finish ?? (tools.size > 0 ? "tool_calls" : "stop") }],
  };
  if (usage) payload.usage = usage;
  return Response.json(payload);
}
