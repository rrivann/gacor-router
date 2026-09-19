// 9router-inspired log format for pool rotation activity. All lines go
// through console.info/warn/error which flow into the ring buffer + WS
// event bus set up in src/lib/consoleLog.ts (v0.3.9), so the dashboard's
// /console-log page picks them up automatically with the right color per
// level. A silent rotation used to be invisible from the UI — users saw
// "API error · Retrying in 51s" with no explanation. Now they see the
// full ▶/✗/⚠️/📊 trace as it happens.

function ts(): string {
  const d = new Date();
  const h = String(d.getHours()).padStart(2, "0");
  const m = String(d.getMinutes()).padStart(2, "0");
  const s = String(d.getSeconds()).padStart(2, "0");
  return `[${h}:${m}:${s}]`;
}

function fmtDuration(ms: number): string {
  return `${ms}ms`;
}

export function logRequestStart(opts: {
  providerName: string;
  model: string;
  accountLabel: string;
  stream: boolean;
  messages: number;
  tools: number;
  think?: string | null;
}): void {
  const kind = opts.stream ? "STREAM" : "SYNC";
  const tools = opts.tools > 0 ? ` · ${opts.tools} TOOL` : "";
  const think = opts.think ? ` · THINK:${opts.think}` : "";
  console.info(
    `${ts()} 🟤 ▶ POST ${opts.providerName}/${opts.model} · ${kind} · ${opts.messages} MSG${tools}${think} · ACC:${opts.accountLabel}`
  );
}

// Extract a short THINK indicator from the client body — covers the three
// wire shapes we see in the wild:
//   1. remove native chat: { thinking: { type: "enabled" | "auto", budget_tokens?: N } }
//   2. remove Code Assistant beta:  { output_config: { effort: "max" | "high" | ... } }
//                                or a top-level { effort: "max" | ... }
//   3. 0penAI reasoning:      { reasoning_effort: "low" | "medium" | "high" }
// Returns null when the client didn't ask for thinking (so we skip the ·
// THINK:... segment entirely — the request line stays clean).
export function extractThinkLevel(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;

  // remove native thinking block.
  const thinking = b.thinking as
    | { type?: string; budget_tokens?: number | string }
    | undefined;
  if (thinking && typeof thinking === "object") {
    if (thinking.type === "disabled") return "off";
    const budget = thinking.budget_tokens;
    if (typeof budget === "number" && budget > 0) return String(budget);
    if (typeof budget === "string" && budget) return budget;
    if (thinking.type === "enabled" || thinking.type === "auto") return thinking.type;
  }

  // Code Assistant beta effort — nested or top-level.
  const outputCfg = b.output_config as { effort?: string } | undefined;
  const effort =
    (outputCfg && typeof outputCfg === "object" && outputCfg.effort) ||
    (typeof b.effort === "string" ? b.effort : undefined);
  if (typeof effort === "string" && effort) return effort;

  // 0penAI-flavoured reasoning_effort (o3, o4-mini, …).
  const reasoning = b.reasoning_effort;
  if (typeof reasoning === "string" && reasoning) return reasoning;

  return null;
}

export function logRequestError(opts: {
  status: number;
  providerName: string;
  model: string;
  durationMs: number;
  body: string;
}): void {
  const snippet = opts.body.slice(0, 200).replace(/\s+/g, " ").trim();
  console.error(
    `${ts()} 🟤 ✗ ERROR ${opts.status} · ${opts.providerName}/${opts.model} · ${fmtDuration(opts.durationMs)} · ${snippet}`
  );
}

export function logRequestDone(opts: {
  providerName: string;
  model: string;
  durationMs: number;
  ttftMs: number | null;
  promptTokens: number | null;
  completionTokens: number | null;
  cachedTokens: number | null;
  cacheWriteTokens: number | null;
}): void {
  const ttft = opts.ttftMs != null ? ` · TTFT ${opts.ttftMs}ms` : "";
  // Cache line combines 9router's single-number shape (total tokens the
  // upstream saw as cache) with our own W/R breakdown — same-cost cache
  // reads and expensive cache writes have very different bills, and
  // scanning the log for "am I actually hitting cache" needs both numbers.
  //
  // W is "—" (dash) rather than "0" when the upstream never reported a
  // cache_creation field — glm-5.2 uses implicit cache (creation cost is
  // absorbed silently, no line item), and rendering "W:0" there implies
  // "0 tokens written" when the truth is "field not applicable". claude
  // upstream explicitly reports 0 vs N, so that case still reads "W:0".
  const total = opts.cachedTokens ?? 0;
  const wRaw = opts.cacheWriteTokens;
  const w = wRaw ?? 0;
  const r = total - w;
  const wDisplay = wRaw == null ? "—" : String(w);
  // IN = fresh tokens only, matching 9router. Our upstream parser folds
  // cache into promptTokens (see src/providers/oaistream.ts:88), so we
  // subtract cache back out here to reach the fresh-input figure —
  // otherwise a 97314-token turn with 45354 cache reads under 300 fresh
  // tokens of user prompt still reads as "IN 97314", which is misleading.
  const promptTotal = opts.promptTokens ?? 0;
  const fresh = Math.max(0, promptTotal - total);
  const cache = total ? ` (CACHE ↻${total} W:${wDisplay} R:${r})` : "";
  console.info(
    `${ts()} 🟤 📊 DONE ${fmtDuration(opts.durationMs)}${ttft} · IN ${fresh}${cache} · OUT ${opts.completionTokens ?? 0}`
  );
}

export function logAutoDisable(accountLabel: string, outcome: "exhausted" | "banned"): void {
  const reason = outcome === "exhausted" ? "credits exhausted" : "auth failed";
  console.warn(`${ts()} ⚠️  [AUTH] Account ${accountLabel} auto-disabled (${reason})`);
}

export function logFallback(fromLabel: string, status: number): void {
  console.warn(
    `${ts()} ⚠️  [FALLBACK] ⇄ ACC:${fromLabel} UNAVAILABLE (${status}) → NEXT ACCOUNT`
  );
}

// Announces every time a real CL4ude Code CLI hits the router — its identity
// headers were just snapshotted and will be forwarded to CodeBuddy on the
// next outbound request. Guarded by the claude_header_overlay setting; if
// the feature is off, the caller never invokes this, so the line stays
// absent from /console-log.
export function logCL4udeHeadersCached(count: number, userAgent: string): void {
  const uaShort = userAgent.length > 40 ? userAgent.slice(0, 40) + "…" : userAgent;
  console.info(`${ts()} 🟤 🏷️  [CL4udeHeaders] cached ${count} hdrs (UA:${uaShort})`);
}
