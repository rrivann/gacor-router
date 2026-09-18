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
}): void {
  const kind = opts.stream ? "STREAM" : "SYNC";
  const tools = opts.tools > 0 ? ` · ${opts.tools} TOOL` : "";
  console.info(
    `${ts()} 🟤 ▶ POST ${opts.providerName}/${opts.model} · ${kind} · ${opts.messages} MSG${tools} · ACC:${opts.accountLabel}`
  );
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
}): void {
  const ttft = opts.ttftMs != null ? ` · TTFT ${opts.ttftMs}ms` : "";
  const cache = opts.cachedTokens ? ` (CACHE ↻${opts.cachedTokens})` : "";
  console.info(
    `${ts()} 🟤 📊 DONE ${fmtDuration(opts.durationMs)}${ttft} · IN ${opts.promptTokens ?? 0}${cache} · OUT ${opts.completionTokens ?? 0}`
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
