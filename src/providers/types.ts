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

// Normalized stream event — providers decode their wire format into these.
export interface StreamEvent {
  text?: string;
  reasoning?: string;
  toolCall?: { id: string; name: string; args: unknown };
  usage?: { inputTokens: number; outputTokens: number; cacheRead?: number };
  finish?: "stop" | "tool_use" | "length";
}

export interface Provider {
  name(): string;
  caps(): Caps;
  buildRequest(req: ChatRequest, acc: Account): Promise<Request>;
  parseStream(resp: Response, req: ChatRequest): AsyncGenerator<StreamEvent>;
  classify(status: number, body: string): Outcome;
}
