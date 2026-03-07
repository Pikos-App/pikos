import { cn } from "@/lib/utils";

interface SmartViewEntryProps {
  label: string;
  icon: React.ReactNode;
  isActive: boolean;
  badge?: number;
  onSelect: () => void;
}

export function SmartViewEntry({ label, icon, isActive, badge, onSelect }: SmartViewEntryProps) {
  return (
    <button
      className={cn(
        "flex w-full items-center gap-2.5 rounded px-2 py-2.5 text-sm select-none",
        isActive
          ? "bg-accent text-accent-foreground"
          : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
      )}
      onClick={onSelect}
    >
      <span className="shrink-0">{icon}</span>
      <span className="flex-1 text-left">{label}</span>
      {badge !== undefined && badge > 0 && (
        <span
          className={cn(
            "ml-auto min-w-[18px] rounded-full px-1.5 py-0.5 text-center text-[11px] leading-none font-medium tabular-nums",
            isActive
              ? "bg-accent-foreground/15 text-accent-foreground"
              : "bg-muted text-muted-foreground"
          )}
        >
          {badge > 99 ? "99+" : badge}
        </span>
      )}
    </button>
  );
}
