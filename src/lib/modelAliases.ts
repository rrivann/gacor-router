// Public model ID ↔ canonical `provider/model` alias table.
//
// Client tools like Code Assistant ship a hardcoded whitelist of model IDs and
// silently reject anything not on it — even when the router says the model
// exists. Their whitelist mirrors remove's own naming (`claude-<family>-<n>-<n>[<ctx>]`),
// so we accept those IDs at the door and route to our upstream naming
// (`codebuddy/claude-opus-4.7-1m` etc.) internally. The 0penAI catalog keeps
// the canonical `codebuddy/...` IDs — dashboard and existing 0penAI clients
// see no change.

const CANONICAL_BY_ALIAS: Record<string, string> = {
  // 1M-context Opus variants. Code Assistant's whitelist has both
  // `claude-opus-4-7` and `claude-opus-4-7[1m]`; both point at the same
  // upstream (there's no separate 200K vs 1M split on the codebuddy side).
  "claude-opus-4-7[1m]": "codebuddy/claude-opus-4.7-1m",
  "claude-opus-4-7": "codebuddy/claude-opus-4.7-1m",
  "claude-opus-4-6": "codebuddy/claude-opus-4.6",
  "claude-opus-5[1m]": "codebuddy/claude-opus-5",
  "claude-opus-5": "codebuddy/claude-opus-5",
  "claude-sonnet-4-6": "codebuddy/claude-sonnet-4.6",
};

// Reverse index built once at module load — no need for a hot-path lookup
// helper since the table is tiny.
const ALIASES_BY_CANONICAL: Record<string, string[]> = (() => {
  const out: Record<string, string[]> = {};
  for (const [alias, canonical] of Object.entries(CANONICAL_BY_ALIAS)) {
    (out[canonical] ??= []).push(alias);
  }
  return out;
})();

export function resolveAlias(publicId: string): string | null {
  return CANONICAL_BY_ALIAS[publicId] ?? null;
}

export function publicAliasesFor(canonicalId: string): string[] {
  return ALIASES_BY_CANONICAL[canonicalId] ?? [];
}
