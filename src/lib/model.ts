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
    const provider = source.slice(0, slash);
    const model = source.slice(slash + 1);
    // Lenient: a user who typed `codebuddy/claude-opus-4-7[1m]` (aliased
    // model glued to a provider prefix) still gets routed correctly. We
    // resolve the tail through the alias table too and re-split if that
    // yields a canonical `provider/model`. Otherwise the provider stays
    // whatever the client asked for.
    const tailAlias = resolveAlias(model);
    if (tailAlias) {
      const tailSlash = tailAlias.indexOf("/");
      if (tailSlash > 0 && tailSlash < tailAlias.length - 1) {
        return { provider: tailAlias.slice(0, tailSlash), model: tailAlias.slice(tailSlash + 1) };
      }
    }
    return { provider, model };
  }
  const fallback = getSetting("default_provider");
  if (!fallback) return null;
  return { provider: fallback, model: source };
}
