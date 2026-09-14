import type { HTMLAttributes } from "react";
import { cn } from "../../lib/utils";

type Variant = "default" | "success" | "warning" | "error" | "info" | "secondary" | "outline";

const styles: Record<Variant, string> = {
  default: "bg-primary/15 text-primary border-primary/30",
  success: "bg-success/15 text-success border-success/30",
  warning: "bg-warning/15 text-warning border-warning/30",
  error: "bg-error/15 text-error border-error/30",
  info: "bg-info/15 text-info border-info/30",
  secondary: "bg-secondary text-secondary-foreground border-transparent",
  outline: "bg-transparent text-muted-foreground border-border",
};

export function Badge({
  variant = "default",
  className,
  ...props
}: HTMLAttributes<HTMLSpanElement> & { variant?: Variant }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide",
        styles[variant],
        className
      )}
      {...props}
    />
  );
}
