import { cn } from "@/lib/utils";

interface SmartViewEntryProps {
  label: string;
  icon: React.ReactNode;
  isActive: boolean;
  badge?: number;
  onSelect: () => void;
  dragRef?: (node: HTMLElement | null) => void;
  isDragOver?: boolean;
  id?: string;
}

export function SmartViewEntry({
  badge,
  dragRef,
  icon,
  id,
  isActive,
  isDragOver,
  label,
  onSelect,
}: SmartViewEntryProps) {
  return (
    <button
      aria-current={isActive ? "true" : undefined}
      className={cn(
        "type-ui flex w-full items-center gap-2.5 rounded-r border-l-2 px-2 py-2.5 transition-[background-color,color] duration-[120ms] ease-out select-none",
        isDragOver
          ? "border-l-transparent bg-accent text-accent-foreground"
          : isActive
            ? "border-l-interactive-primary bg-surface-selected text-accent-foreground"
            : "border-l-transparent text-muted-foreground hover:bg-surface-hover hover:text-foreground"
      )}
      id={id}
      onClick={onSelect}
      ref={dragRef}
      tabIndex={-1}
    >
      <span className="shrink-0">{icon}</span>
      <span className="flex-1 text-left">{label}</span>
      {badge !== undefined && badge > 0 && (
        <span className="type-ui-sm ml-auto text-subtle tabular-nums">
          {badge > 99 ? "99+" : badge}
        </span>
      )}
    </button>
  );
}
