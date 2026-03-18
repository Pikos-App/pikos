import { cn } from "@/lib/utils";

interface SmartViewEntryProps {
  label: string;
  icon: React.ReactNode;
  isActive: boolean;
  badge?: number;
  onSelect: () => void;
  dragRef?: (node: HTMLElement | null) => void;
  isDragOver?: boolean;
}

export function SmartViewEntry({
  label,
  icon,
  isActive,
  badge,
  onSelect,
  dragRef,
  isDragOver,
}: SmartViewEntryProps) {
  return (
    <button
      ref={dragRef}
      className={cn(
        "flex w-full items-center gap-2.5 rounded px-2 py-2.5 text-sm select-none",
        isActive || isDragOver
          ? "bg-accent text-accent-foreground"
          : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
      )}
      onClick={onSelect}
    >
      <span className="shrink-0">{icon}</span>
      <span className="flex-1 text-left">{label}</span>
      {badge !== undefined && badge > 0 && (
        <span className="ml-auto text-[11px] text-muted-foreground/60 tabular-nums">
          {badge > 99 ? "99+" : badge}
        </span>
      )}
    </button>
  );
}
