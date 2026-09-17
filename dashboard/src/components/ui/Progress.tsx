// Compact horizontal progress bar with auto-tiered color (etteum pattern):
// low remaining = error, low-ish = warning, else success. Callers pass the
// remaining percentage (0-100); tone flips automatically. `tone="fixed"`
// opts out of the auto-switch when the meter isn't a "how much is left"
// signal (e.g. a queue progress bar where full is good).

import { cn } from "../../lib/utils";

interface ProgressProps {
  value: number;
  className?: string;
  tone?: "auto" | "primary" | "success";
  height?: "sm" | "md";
}

export function Progress({ value, className, tone = "auto", height = "sm" }: ProgressProps) {
  const pct = Math.max(0, Math.min(100, value));
  const barColor =
    tone === "primary"
      ? "bg-primary"
      : tone === "success"
        ? "bg-success"
        : pct <= 10
          ? "bg-error"
          : pct <= 40
            ? "bg-warning"
            : "bg-success";
  return (
    <div
      className={cn(
        "w-full overflow-hidden rounded-full bg-secondary",
        height === "sm" ? "h-1.5" : "h-2",
        className
      )}
      role="progressbar"
      aria-valuenow={pct}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <div
        className={cn("h-full rounded-full transition-all duration-300", barColor)}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}
