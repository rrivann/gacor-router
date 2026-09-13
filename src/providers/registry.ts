// Provider registry — sync-safe Map, sorted names (deterministic ordering).

import type { Provider } from "./types";

class Registry {
  #m = new Map<string, Provider>();

  register(p: Provider): void {
    this.#m.set(p.name(), p);
  }

  unregister(name: string): void {
    this.#m.delete(name);
  }

  get(name: string): Provider | undefined {
    return this.#m.get(name);
  }

  names(): string[] {
    return [...this.#m.keys()].sort();
  }
}

export const registry = new Registry();
