// Provider boundary (enowX-inspired, ported to TS).
// Each upstream implements this small interface; the pool and proxy never
// see provider-specific quirks.

export interface Account {
  id: number;
  label: string;
  secret: string;
  creds: Record<string, string>;
}

export type Outcome = "ok" | "transient" | "exhausted" | "dead";

export interface Caps {
  chat: boolean;
  images: boolean;
}

// Canonical internal request — everything is normalized into this shape
// before a provider builds its wire format.
export interface ChatRequest {
  model: string;
  messages: CanonicalMessage[];
  stream: boolean;
  tools?: unknown[];
  maxTokens?: number;
  temperature?: number;
  raw?: unknown; // original client payload, for passthrough providers
}

export interface CanonicalMessage {
  role: "system" | "user" | "assistant" | "tool";
  parts: { type: "text" | "image"; text?: string; mimeType?: string; data?: string }[];
  toolCalls?: { id: string; name: string; args: unknown }[];
  toolCallId?: string;
}

// One streamed tool-call fragment. OpenAI-on-the-wire upstreams send tool
// arguments as partial JSON strings spread across chunks (`{"pa`, `th":"/tmp`,
// ...), keyed by `index`; the fragment is passed through as-is so clients can
// render tool arguments while they stream. Reassembly is the consumer's job.
export interface ToolCallDelta {
  index: number;
  id?: string;
  name?: string;
  argsDelta?: string;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheRead?: number;
  cacheWrite?: number;
}

// Normalized stream event — providers decode their wire format into these.
export interface StreamEvent {
  text?: string;
  reasoning?: string;
  toolCalls?: ToolCallDelta[];
  usage?: Usage;
  model?: string;
  finish?: FinishReason;
}

export type FinishReason = "stop" | "tool_calls" | "length" | "content_filter";

// A model the provider can serve. Upstreams like CodeBuddy expose no live
// catalogue, so providers ship a static list.
export interface ModelInfo {
  id: string;
  maxInputTokens?: number;
  maxOutputTokens?: number;
  ownedBy?: string;
}

export interface Provider {
  name(): string;
  caps(): Caps;
  buildRequest(req: ChatRequest, acc: Account): Promise<Request>;
  parseStream(resp: Response, req: ChatRequest): AsyncGenerator<StreamEvent>;
  classify(status: number, body: string): Outcome;
  // Optional: static catalogue for GET /v1/models.
  models?(): ModelInfo[];
}
