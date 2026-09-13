// Account pool (enowX-inspired): pick a usable account, skip already-tried
// ones within the same request, sticky by default with optional round-robin.

import type { Account } from "../providers/types";

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
    private rotation: (provider: string) => RotationMode = () => "sticky"
  ) {}

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
