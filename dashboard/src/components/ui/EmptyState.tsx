// Consistent empty-state box used across the app. Two variants:
//   solid  — border + card background, sits inside a Card wrapper
//   dashed — primary-tinted dashed border + faint primary wash, works
//            standalone (etteum's gold-standard empty state)
// Icon-in-halo + short copy + optional CTA. Retires the bare "No X yet"
// one-liners the audit flagged on Requests / Settings / Filters / etc.

import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { cn } from "../../lib/utils";

interface EmptyStateProps {
  icon: LucideIcon;
  title: string;
  hint?: ReactNode;
  action?: ReactNode;
  variant?: "solid" | "dashed";
  className?: string;
}

export function EmptyState({
  icon: Icon,
  title,
  hint,
  action,
  variant = "solid",
  className,
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        "rounded-xl p-10 text-center",
        variant === "dashed"
          ? "border border-dashed border-primary/20 bg-primary/[0.02]"
          : "border border-border bg-card",
        className
      )}
    >
      <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-primary/10 text-primary">
        <Icon className="h-5 w-5" />
      </div>
      <p className="mt-3 text-sm font-medium">{title}</p>
      {hint && <p className="mx-auto mt-1.5 max-w-md text-xs text-muted-foreground">{hint}</p>}
      {action && <div className="mt-4 flex justify-center">{action}</div>}
    </div>
  );
}
