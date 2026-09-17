import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "../../lib/utils";

interface CardProps extends HTMLAttributes<HTMLDivElement> {
  /**
   * When true, the card gets a subtle interactive hover: primary-tinted border
   * + `--glow` shadow and a pointer cursor. Match 9router's warm halo pattern.
   */
  hover?: boolean;
}

export function Card({ hover, className, ...props }: CardProps) {
  return (
    <div
      className={cn(
        "rounded-lg border border-border bg-card text-card-foreground shadow-[var(--shadow-card)]",
        hover &&
          "cursor-pointer transition-all duration-200 hover:border-primary/40 hover:shadow-[var(--glow)]",
        className
      )}
      {...props}
    />
  );
}

export function CardHeader({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("flex flex-col gap-1 p-4 pb-2", className)} {...props} />;
}

export function CardTitle({ className, ...props }: HTMLAttributes<HTMLHeadingElement>) {
  return <h3 className={cn("text-sm font-semibold tracking-tight", className)} {...props} />;
}

export function CardContent({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("p-4 pt-2", className)} {...props} />;
}

export function CardDescription({ className, ...props }: HTMLAttributes<HTMLParagraphElement>) {
  return <p className={cn("text-xs text-muted-foreground", className)} {...props} />;
}

export type { ReactNode };
