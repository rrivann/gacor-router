// Account pool (enowX-inspired): pick a usable account, skip already-tried
// ones within the same request, sticky by default with optional round-robin.

import type { Account, Outcome } from "../providers/types";

export interface AccountRow {
  id: number;
  provider: string;
  label: string | null;
  secret: string;
  creds: Record<string, string> | null;
  status: string;
}

export type RotationMode = "sticky" | "round-robin";

export class Pool {
  #next = new Map<string, number>();

  constructor(
    private list: (provider: string) => AccountRow[],
    private rotation: (provider: string) => RotationMode = () => "sticky",
    private setStatus: (id: number, status: string) => void = () => {},
    private updateCreds: (id: number, creds: Record<string, string>) => void = () => {}
  ) {}

  // Reflect a request's outcome back onto the account. "transient" is
  // deliberately not persisted: the failure isn't the account's fault (5xx, or
  // a rate limit scoped to one model), so it stays in the pool.
  react(id: number, outcome: Outcome): void {
    if (outcome === "dead") this.setStatus(id, "banned");
    else if (outcome === "exhausted") this.setStatus(id, "exhausted");
  }

  // Write refreshed credentials back to storage. No-op unless the pool was
  // constructed with an updateCreds sink.
  persistCreds(id: number, creds: Record<string, string>): void {
    this.updateCreds(id, creds);
  }

  pick(provider: string, tried = new Set<number>()): Account | null {
    const usable = this.list(provider).filter(
      (a) => a.status === "active" && !tried.has(a.id)
    );
    if (usable.length === 0) return null;

    let idx = 0;
    if (usable.length > 1 && this.rotation(provider) === "round-robin") {
      const cursor = (this.#next.get(provider) ?? 0) % usable.length;
      this.#next.set(provider, cursor + 1);
      idx = cursor;
    }
    const a = usable[idx]!;
    return {
      id: a.id,
      label: a.label ?? `#${a.id}`,
      secret: a.secret,
      creds: a.creds ?? {},
    };
  }
}
