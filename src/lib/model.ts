// Model routing: clients address an upstream as `provider/model`, e.g.
// `codebuddy/claude-opus-5`. Only the first slash is the separator, so model
// ids that themselves contain slashes survive intact.
// Without a prefix we fall back to the `default_provider` setting.

import { getSetting } from "../db/accounts";

export interface Route {
  provider: string;
  model: string;
}

export function resolveModel(raw: string): Route | null {
  const slash = raw.indexOf("/");
  if (slash > 0 && slash < raw.length - 1) {
    return { provider: raw.slice(0, slash), model: raw.slice(slash + 1) };
  }
  const fallback = getSetting("default_provider");
  if (!fallback) return null;
  return { provider: fallback, model: raw };
}
