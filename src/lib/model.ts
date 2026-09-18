// Model routing: clients address an upstream as `provider/model`, e.g.
// `codebuddy/claude-opus-5`. Only the first slash is the separator, so model
// ids that themselves contain slashes survive intact.
// Without a prefix we fall back to the `default_provider` setting.

import { getSetting } from "../db/accounts";
import { resolveAlias } from "./modelAliases";

export interface Route {
  provider: string;
  model: string;
}

export function resolveModel(raw: string): Route | null {
  // Alias short-circuit — remove-native IDs (`claude-opus-4-7[1m]`) map to a
  // canonical `provider/model` string before the normal split runs. Keeps
  // Code Assistant's hardcoded whitelist happy without duplicating registry
  // entries.
  const aliased = resolveAlias(raw);
  const source = aliased ?? raw;

  const slash = source.indexOf("/");
  if (slash > 0 && slash < source.length - 1) {
    return { provider: source.slice(0, slash), model: source.slice(slash + 1) };
  }
  const fallback = getSetting("default_provider");
  if (!fallback) return null;
  return { provider: fallback, model: source };
}
