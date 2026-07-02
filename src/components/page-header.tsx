import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * Slim header bar that sits at the top of each page's content area.
 * Left: title (+ optional subtitle / breadcrumb). Right: page actions.
 */
export function PageHeader({
  title,
  subtitle,
  icon,
  children,
  className,
}: {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  icon?: React.ReactNode;
  children?: React.ReactNode;
  className?: string;
}) {
  return (
    <header
      className={cn(
        "flex h-14 shrink-0 items-center gap-3 border-b border-zinc-200 bg-white/80 px-6 backdrop-blur-sm",
        className
      )}
    >
      {icon && (
        <span className="flex size-7 items-center justify-center rounded-lg bg-zinc-100 text-zinc-500">
          {icon}
        </span>
      )}
      <div className="min-w-0">
        <h1 className="truncate text-sm font-semibold tracking-tight text-zinc-900">
          {title}
        </h1>
        {subtitle && (
          <p className="truncate text-xs text-zinc-500">{subtitle}</p>
        )}
      </div>
      {children && (
        <div className="ml-auto flex items-center gap-2">{children}</div>
      )}
    </header>
  );
}
