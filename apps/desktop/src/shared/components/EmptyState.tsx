import type { LucideIcon } from "lucide-react";

interface EmptyStateProps {
  icon?: LucideIcon;
  message: string;
  children?: React.ReactNode;
}

export function EmptyState({ children, icon: Icon, message }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-4 py-12">
      {Icon && <Icon className="text-text-tertiary" size={24} strokeWidth={1} />}
      <div className="text-center">
        <p className="type-body-sm text-text-tertiary">{message}</p>
        {children}
      </div>
    </div>
  );
}
