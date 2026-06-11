import type { LucideIcon } from "lucide-react";

import { cn } from "@/lib/utils";

interface EmptyStateProps {
  icon?: LucideIcon;
  message: string;
  children?: React.ReactNode;
  compact?: boolean;
}

export function EmptyState({ children, compact = false, icon: Icon, message }: EmptyStateProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center px-4",
        compact ? "gap-2 py-6" : "gap-3 py-12"
      )}
    >
      {Icon && <Icon className="text-text-tertiary" size={24} strokeWidth={1} />}
      <div className="text-center">
        <p className="type-body-sm text-text-tertiary">{message}</p>
        {children}
      </div>
    </div>
  );
}
