// Model pricing tiers in USD per 1M tokens (retail rates from provider docs).
//
// CodeBuddy meters requests as fractional "credits" internally, not dollars —
// this table calculates what the same call would cost at retail if you hit
// the underlying provider (0penAI, remove, Google, etc.) directly. Useful
// for comparing gateway savings against direct API spend.
//
// Fallback order (first match wins):
//   1. MODEL_PRICING[model]  — exact match by short id
//   2. PATTERN_PRICING       — glob pattern (first match wins)
//   3. null                  — dollarCost stays null

export interface PricingTier {
  input: number; // $/1M
  output: number;
  cached: number; // cache_read
  cacheCreation: number; // cache_write
  reasoning: number;
}

// Adapted from 9router/open-sse/providers/pricing.js (subset covering the
// CodeBuddy catalogue). Rates are USD per 1M tokens.
const MODEL_PRICING: Record<string, PricingTier> = {
  // remove / CL4ude
  "claude-sonnet-4.6": { input: 3.0, output: 15.0, cached: 0.3, cacheCreation: 3.75, reasoning: 15.0 },
  "claude-opus-4.6": { input: 5.0, output: 25.0, cached: 0.5, cacheCreation: 6.25, reasoning: 25.0 },
  "claude-opus-4.7-1m": { input: 5.0, output: 25.0, cached: 0.5, cacheCreation: 6.25, reasoning: 25.0 },
  "claude-opus-5": { input: 5.0, output: 25.0, cached: 0.5, cacheCreation: 6.25, reasoning: 25.0 },
  "claude-fable-5": { input: 10.0, output: 50.0, cached: 1.0, cacheCreation: 12.5, reasoning: 50.0 },

  // 0penAI / GPT
  "gpt-5.4": { input: 1.25, output: 10.0, cached: 0.625, cacheCreation: 1.25, reasoning: 10.0 },
  "gpt-5.5": { input: 1.25, output: 10.0, cached: 0.625, cacheCreation: 1.25, reasoning: 10.0 },
  "gpt-5.6-luna": { input: 1.0, output: 6.0, cached: 0.1, cacheCreation: 1.0, reasoning: 6.0 },
  "gpt-5.6-terra": { input: 2.5, output: 15.0, cached: 0.25, cacheCreation: 2.5, reasoning: 15.0 },
  "gpt-5.6-sol": { input: 5.0, output: 30.0, cached: 0.5, cacheCreation: 5.0, reasoning: 30.0 },
  "gpt-5.3-codex": { input: 1.75, output: 14.0, cached: 0.175, cacheCreation: 1.75, reasoning: 14.0 },
  "gpt-6-astra": { input: 5.0, output: 30.0, cached: 0.5, cacheCreation: 5.0, reasoning: 30.0 },

  // Gemini
  "gemini-3.1-pro": { input: 2.0, output: 12.0, cached: 0.25, cacheCreation: 2.0, reasoning: 18.0 },
  "gemini-3.5-flash": { input: 0.5, output: 3.0, cached: 0.03, cacheCreation: 0.5, reasoning: 4.5 },

  // DeepSeek
  "deepseek-v3-0324": { input: 0.14, output: 0.28, cached: 0.0028, cacheCreation: 0.14, reasoning: 0.28 },
  "deepseek-v4.1-flash": { input: 0.14, output: 0.28, cached: 0.0028, cacheCreation: 0.14, reasoning: 0.28 },

  // Hunyuan (Tencent)
  "hy3": { input: 0.3, output: 1.2, cached: 0.06, cacheCreation: 0.3, reasoning: 1.8 },
  "hy4-preview": { input: 0.5, output: 2.0, cached: 0.1, cacheCreation: 0.5, reasoning: 3.0 },
  "hy4-preview-f": { input: 0.3, output: 1.2, cached: 0.06, cacheCreation: 0.3, reasoning: 1.8 },

  // GLM (Zhipu)
  "glm-5.2": { input: 1.0, output: 4.0, cached: 0.5, cacheCreation: 1.0, reasoning: 6.0 },
  "glm-5.3": { input: 1.0, output: 4.0, cached: 0.5, cacheCreation: 1.0, reasoning: 6.0 },

  // Kimi (Moonshot)
  "kimi-k2.5": { input: 1.2, output: 4.8, cached: 0.6, cacheCreation: 1.2, reasoning: 7.2 },
  "kimi-k2.6": { input: 1.2, output: 4.8, cached: 0.6, cacheCreation: 1.2, reasoning: 7.2 },
  "kimi-k2.8-preview": { input: 1.5, output: 6.0, cached: 0.75, cacheCreation: 1.5, reasoning: 9.0 },
  "kimi-k3": { input: 1.5, output: 6.0, cached: 0.75, cacheCreation: 1.5, reasoning: 9.0 },

  // MiniMax
  "minimax-m3": { input: 0.3, output: 1.2, cached: 0.06, cacheCreation: 0.3, reasoning: 1.8 },
};

// Pattern-based fallback (first match wins).
interface PatternEntry {
  pattern: RegExp;
  pricing: PricingTier;
}

// Compile "*" glob → regex `.*` (anchored). Order matters — most specific first.
function glob(pattern: string): RegExp {
  const esc = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${esc}$`);
}

const PATTERN_PRICING: PatternEntry[] = [
  { pattern: glob("claude-opus-*"), pricing: { input: 5.0, output: 25.0, cached: 0.5, cacheCreation: 6.25, reasoning: 25.0 } },
  { pattern: glob("claude-sonnet-*"), pricing: { input: 3.0, output: 15.0, cached: 0.3, cacheCreation: 3.75, reasoning: 15.0 } },
  { pattern: glob("claude-haiku-*"), pricing: { input: 1.0, output: 5.0, cached: 0.1, cacheCreation: 1.25, reasoning: 5.0 } },
  { pattern: glob("claude-*"), pricing: { input: 3.0, output: 15.0, cached: 0.3, cacheCreation: 3.75, reasoning: 15.0 } },
  { pattern: glob("gpt-*-codex"), pricing: { input: 1.75, output: 14.0, cached: 0.175, cacheCreation: 1.75, reasoning: 14.0 } },
  { pattern: glob("gpt-*"), pricing: { input: 2.5, output: 15.0, cached: 0.25, cacheCreation: 2.5, reasoning: 15.0 } },
  { pattern: glob("gemini-*-flash*"), pricing: { input: 0.3, output: 2.5, cached: 0.03, cacheCreation: 0.3, reasoning: 3.75 } },
  { pattern: glob("gemini-*-pro*"), pricing: { input: 2.0, output: 12.0, cached: 0.25, cacheCreation: 2.0, reasoning: 18.0 } },
  { pattern: glob("gemini-*"), pricing: { input: 0.5, output: 3.0, cached: 0.03, cacheCreation: 0.5, reasoning: 4.5 } },
  { pattern: glob("deepseek-*"), pricing: { input: 0.14, output: 0.28, cached: 0.0028, cacheCreation: 0.14, reasoning: 0.28 } },
  { pattern: glob("glm-*"), pricing: { input: 1.0, output: 4.0, cached: 0.5, cacheCreation: 1.0, reasoning: 6.0 } },
  { pattern: glob("kimi-*"), pricing: { input: 1.2, output: 4.8, cached: 0.6, cacheCreation: 1.2, reasoning: 7.2 } },
  { pattern: glob("hy*"), pricing: { input: 0.3, output: 1.2, cached: 0.06, cacheCreation: 0.3, reasoning: 1.8 } },
  { pattern: glob("minimax-*"), pricing: { input: 0.3, output: 1.2, cached: 0.06, cacheCreation: 0.3, reasoning: 1.8 } },
];

export function pricingFor(model: string): PricingTier | null {
  if (MODEL_PRICING[model]) return MODEL_PRICING[model];
  for (const entry of PATTERN_PRICING) {
    if (entry.pattern.test(model)) return entry.pricing;
  }
  return null;
}

// Compute retail-equivalent dollar cost for one request.
//
// `inputTokens` is the 0penAI convention (INCLUSIVE of cached). We split:
//   billable input = inputTokens - cacheRead - cacheWrite  (fresh input)
//   cache_read = cacheRead                                  (cheaper tier)
//   cache_write = cacheWrite                                (usually pricier than input)
//   reasoning = reasoning tokens (subset of output, priced separately)
//   output = outputTokens - reasoning                       (non-thinking output)
//
// Returns null when the model isn't in the pricing table.
export function computeDollarCost(
  model: string,
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheRead?: number | null;
    cacheWrite?: number | null;
    reasoning?: number | null;
  }
): number | null {
  const tier = pricingFor(model);
  if (!tier) return null;
  const cr = usage.cacheRead ?? 0;
  const cw = usage.cacheWrite ?? 0;
  const reasoning = usage.reasoning ?? 0;
  const freshInput = Math.max(0, usage.inputTokens - cr - cw);
  const plainOutput = Math.max(0, usage.outputTokens - reasoning);
  const per = 1_000_000;
  return (
    (freshInput * tier.input +
      cr * tier.cached +
      cw * tier.cacheCreation +
      reasoning * tier.reasoning +
      plainOutput * tier.output) /
    per
  );
}
