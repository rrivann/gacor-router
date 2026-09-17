// Placeholder block for loading states. Callers set the size via className
// (e.g. `h-6 w-32` for a text line, `h-24 w-full` for a card). Replaces the
// scattered "Loading…" strings and bare spinners the audit flagged.

import { cn } from "../../lib/utils";

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn("animate-pulse rounded-md bg-secondary/60", className)} />;
}
