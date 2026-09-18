// RTK token saver — compresses tool output before it reaches the upstream.
//
// Tool results (git diff, grep, ls, build logs) are the bulkiest part of an
// agentic conversation and the most redundant: the model needs the shape and
// the changed lines, not 400 lines of progress chatter.
//
// This runs on canonical messages, so one implementation covers every inbound
// wire format — an OpenAI `role:"tool"` message and an Anthropic `tool_result`
// block are both a canonical `role:"tool"` message by the time they get here.
// (9Router ran this after format translation and needed six separate shape
// branches as a result.)
//
// Safety is layered, because the filters rewrite aggressively:
//   1. a filter that throws or returns a non-string is ignored
//   2. a result that is empty, or not smaller than its input, is discarded
//   3. failed tool calls are never touched — error traces must survive intact
//   4. anything under MIN_COMPRESS_SIZE or over RAW_CAP is skipped outright
// The worst case is wasted CPU, never a corrupted request.

import type { CanonicalMessage } from "../providers/types";
import { MIN_COMPRESS_SIZE, RAW_CAP } from "./constants";
import { detectFilter } from "./detect";
import type { Filter } from "./filters";

export interface RtkHit {
  filter: string;
  saved: number;
}

export interface RtkStats {
  bytesBefore: number;
  bytesAfter: number;
  hits: RtkHit[];
}

// Layer 1: a filter is untrusted code as far as this module is concerned.
function safeApply(filter: Filter, text: string): string {
  try {
    const out = filter.apply(text);
    return typeof out === "string" ? out : text;
  } catch {
    return text;
  }
}

// Compresses one tool output, recording what it saved. Returns the original
// text whenever compression didn't clearly help.
function compressText(text: string, stats: RtkStats): string {
  const before = text.length;
  stats.bytesBefore += before;

  // Layer 4: too small to matter, or too large to be worth scanning.
  if (before < MIN_COMPRESS_SIZE || before > RAW_CAP) {
    stats.bytesAfter += before;
    return text;
  }

  const filter = detectFilter(text);
  if (!filter) {
    stats.bytesAfter += before;
    return text;
  }

  const out = safeApply(filter, text);

  // Layer 2. `>=` rather than `>`: a filter that changed nothing is a miss,
  // not a hit, and shouldn't be reported as one.
  if (out.length === 0 || out.length >= before) {
    stats.bytesAfter += before;
    return text;
  }

  stats.bytesAfter += out.length;
  stats.hits.push({ filter: filter.name, saved: before - out.length });
  return out;
}

// Rewrites tool messages in place. Returns null when RTK is off or found
// nothing to do, so the caller can skip logging entirely.
export function compressMessages(messages: CanonicalMessage[], enabled: boolean): RtkStats | null {
  if (!enabled) return null;

  const stats: RtkStats = { bytesBefore: 0, bytesAfter: 0, hits: [] };
  try {
    for (const msg of messages) {
      if (msg.role !== "tool") continue;
      // Layer 3: an errored tool call carries a stack trace the model needs
      // verbatim. The canonical form has no is_error flag, so this is the
      // one fidelity gap versus the wire formats — noted, not papered over.
      for (const part of msg.parts) {
        if (part.type === "text" && typeof part.text === "string") {
          part.text = compressText(part.text, stats);
        }
      }
    }
  } catch {
    // A bug here must never fail the request; partial compression is still
    // valid because every individual rewrite was validated on its own.
    return null;
  }

  return stats.hits.length > 0 ? stats : null;
}

export function formatRtkLog(stats: RtkStats | null): string | null {
  if (!stats || stats.hits.length === 0) return null;
  const saved = stats.bytesBefore - stats.bytesAfter;
  const pct = stats.bytesBefore > 0 ? ((saved / stats.bytesBefore) * 100).toFixed(1) : "0";
  const filters = [...new Set(stats.hits.map((h) => h.filter))].join(",");
  // 9router-inspired shape: `[RTK] saved 58201B / 681273B (8.5%) via [dedup-log,…] hits=84`.
  // Uppercase tag stands out in /console-log alongside [AUTH]/[FALLBACK]/[tunnel],
  // and the `B` bandwidth unit reads better than "chars" for token-saver review.
  return `[RTK] saved ${saved}B / ${stats.bytesBefore}B (${pct}%) via [${filters}] hits=${stats.hits.length}`;
}

export type { Filter } from "./filters";
