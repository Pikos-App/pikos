import type { LucideIcon } from "lucide-react";

import { cn } from "@/lib/utils";

interface ProviderOptionProps {
  icon: LucideIcon;
  iconClassName?: string | undefined;
  title: string;
  subtitle: string;
  disabled: boolean;
  onClick: () => void;
}

export function ProviderOption({
  disabled,
  icon: Icon,
  iconClassName,
  onClick,
  subtitle,
  title,
}: ProviderOptionProps) {
  return (
    <button
      className="flex items-center gap-3 rounded-lg border border-border px-3 py-2.5 text-left transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent"
      disabled={disabled}
      onClick={onClick}
    >
      <Icon className={cn("size-4 text-muted-foreground", iconClassName)} />
      <div>
        <p className="text-sm font-medium">{title}</p>
        <p className="text-xs text-muted-foreground">{subtitle}</p>
      </div>
    </button>
  );
}
