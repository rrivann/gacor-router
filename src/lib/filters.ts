// Content-filter engine: compile the DB rows once, apply to every canonical
// message text before the request reaches the provider. Malformed regex is
// skipped silently so one bad rule doesn't disable the rest.
//
// Called from the api layer between resolve() and RTK compression, so the
// filtered messages flow through the same downstream path as any request —
// RTK, provider.buildRequest, everything.

import { listContentFilters, type ContentFilterRow } from "../db/filters";
import type { CanonicalMessage } from "../providers/types";

interface CompiledRule {
  id: number;
  pattern: string;
  // Returns the rewritten string plus a hit count — the count is per-match
  // so a single rule that fires 3 times shows up as `hits: 3` in the log.
  match: (text: string) => { next: string; hits: number };
  // null = apply to every provider. Otherwise restricted to these names.
  providerScope: string[] | null;
}

// Per-rule breakdown of what actually fired on a request. Persisted in
// request_logs.filters_applied so the /requests detail drawer can render
// which content filters touched a specific message — useful for debugging
// unexpected substitutions after the fact.
export interface FilterApplication {
  id: number;
  pattern: string;
  hits: number;
}

export interface FilterApplyResult {
  rewrites: number;
  applied: FilterApplication[];
}

let cached: CompiledRule[] | null = null;

// Escape a literal string so it becomes a safe regex source. Applied when
// `is_regex: false` so we can always use RegExp under the hood (single code
// path for match + replace, still support the `g` flag for all-occurrences).
function escapeRegex(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function compile(rows: ContentFilterRow[]): CompiledRule[] {
  const out: CompiledRule[] = [];
  for (const row of rows) {
    if (!row.isActive || row.pattern.length === 0) continue;
    try {
      const src = row.isRegex ? row.pattern : escapeRegex(row.pattern);
      const re = new RegExp(src, "g");
      const replacement = row.replacement;
      out.push({
        id: row.id,
        pattern: row.pattern,
        match: (text) => {
          let hits = 0;
          const next = text.replace(re, () => {
            hits++;
            return replacement;
          });
          return { next, hits };
        },
        providerScope: row.providerScope,
      });
    } catch {
      // Bad regex: drop this rule, keep the rest.
    }
  }
  return out;
}

function get(): CompiledRule[] {
  if (cached === null) cached = compile(listContentFilters());
  return cached;
}

// Reset the cache — called by the management API on any write. Cheap: the
// next request rebuilds from the DB, which is a single indexed read.
export function invalidateFilters(): void {
  cached = null;
}

// Rewrite the text of every canonical message in-place. Non-text parts
// (images, tool calls) pass through untouched. Rules with a non-null
// providerScope only fire when providerName is listed in that scope.
// Returns the number of message parts that changed (kept for the existing
// console log line) plus a per-rule breakdown of hits so the request-log
// row can persist which filters actually did work.
export function applyFilters(messages: CanonicalMessage[], providerName: string): FilterApplyResult {
  const all = get();
  const rules = all.filter((r) => r.providerScope === null || r.providerScope.includes(providerName));
  if (rules.length === 0) return { rewrites: 0, applied: [] };

  let rewrites = 0;
  const perRule = new Map<number, FilterApplication>();
  for (const msg of messages) {
    for (const part of msg.parts) {
      if (part.type !== "text" || typeof part.text !== "string" || part.text.length === 0) continue;
      let next = part.text;
      for (const rule of rules) {
        const result = rule.match(next);
        if (result.hits > 0) {
          const existing = perRule.get(rule.id);
          if (existing) {
            existing.hits += result.hits;
          } else {
            perRule.set(rule.id, { id: rule.id, pattern: rule.pattern, hits: result.hits });
          }
          next = result.next;
        }
      }
      if (next !== part.text) {
        part.text = next;
        rewrites++;
      }
    }
  }
  return { rewrites, applied: [...perRule.values()] };
}
