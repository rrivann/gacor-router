// Inline notification banner. Retires the 6+ copies of `rounded-md border
// border-{success|error}/30 bg-{...}/10 px-3 py-2 text-sm` scattered across
// pages. Variant maps to semantic color tokens so light/dark stay in sync.

import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { cn } from "../../lib/utils";

type Variant = "success" | "error" | "warning" | "info";

interface AlertProps {
  variant?: Variant;
  icon?: LucideIcon;
  children: ReactNode;
  className?: string;
}

const TONE: Record<Variant, string> = {
  success: "border-success/30 bg-success/10 text-success",
  error: "border-error/30 bg-error/10 text-error",
  warning: "border-warning/30 bg-warning/10 text-warning",
  info: "border-info/30 bg-info/10 text-info",
};

export function Alert({ variant = "info", icon: Icon, children, className }: AlertProps) {
  return (
    <div
      className={cn(
        "flex items-start gap-2 rounded-md border px-3 py-2 text-sm",
        TONE[variant],
        className
      )}
      role="status"
    >
      {Icon && <Icon className="mt-0.5 h-4 w-4 shrink-0" />}
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
