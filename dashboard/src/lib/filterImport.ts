// Parse + normalize a JSON blob of content-filter rules into the shape our
// createFilter() API accepts. Supports two schemas:
//
// 1. Native gacor bundle:
//    {"filters": [{pattern, replacement, isRegex, isActive, sort, providerScope}, ...]}
// 2. 9router legacy bundle:
//    {"filters": [{pattern, replacement, enabled}, ...], "providerScope": ["codebuddy"]}
//    - `enabled` maps to `isActive`
//    - top-level `providerScope` is merged into each row that lacks its own
//
// A bare `[...]` array is also accepted for permissive user-hand-written
// files. Rows without a string `pattern` are silently dropped — a paste with
// trailing commas or metadata rows should not error the whole import.

export interface NormalizedFilter {
  pattern: string;
  replacement: string;
  isRegex: boolean;
  isActive: boolean;
  sort: number;
  providerScope: string[] | null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function toStringArrayOrNull(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null;
  const arr = v.filter((s): s is string => typeof s === "string" && s.length > 0);
  return arr.length > 0 ? arr : null;
}

export function normalizeFilterBundle(parsed: unknown): NormalizedFilter[] {
  // Unwrap {filters: [...]} or use the array directly.
  let rawFilters: unknown[] = [];
  let bundleScope: string[] | null = null;
  if (Array.isArray(parsed)) {
    rawFilters = parsed;
  } else if (isRecord(parsed) && Array.isArray(parsed.filters)) {
    rawFilters = parsed.filters as unknown[];
    // 9router legacy carries a top-level providerScope applied to every row
    // that doesn't specify its own.
    bundleScope = toStringArrayOrNull(parsed.providerScope);
  } else {
    return [];
  }

  const out: NormalizedFilter[] = [];
  for (const raw of rawFilters) {
    if (!isRecord(raw)) continue;
    if (typeof raw.pattern !== "string" || raw.pattern.length === 0) continue;

    // 9router uses `enabled`; native uses `isActive`. Prefer native when both
    // present (unlikely but well-defined). Default true.
    const activeCandidate = raw.isActive ?? raw.enabled;
    const isActive = activeCandidate === undefined ? true : activeCandidate !== false;

    const perRowScope = toStringArrayOrNull(raw.providerScope);

    out.push({
      pattern: raw.pattern,
      replacement: typeof raw.replacement === "string" ? raw.replacement : "",
      isRegex: raw.isRegex === true,
      isActive,
      sort: typeof raw.sort === "number" && Number.isFinite(raw.sort) ? raw.sort : 0,
      providerScope: perRowScope ?? bundleScope,
    });
  }
  return out;
}
