import { cn } from "@/lib/utils";
import { SIDEBAR_ENTRY_BOX } from "@/shared/components/SidebarListItem";
import { useInterfaceSettings } from "@/shared/context/InterfaceSettingsContext";

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
  const { density } = useInterfaceSettings();
  return (
    <button
      aria-current={isActive ? "true" : undefined}
      className={cn(
        SIDEBAR_ENTRY_BOX,
        "type-ui flex w-full items-center gap-2.5 transition-[background-color,border-color,color] duration-[120ms] ease-out select-none",
        density === "compact" ? "py-1.5" : density === "spacious" ? "py-3" : "py-2.5",
        isDragOver
          ? "bg-accent text-accent-foreground"
          : isActive
            ? "border-border bg-surface-nav-selected text-foreground"
            : "text-muted-foreground hover:bg-surface-hover hover:text-foreground"
      )}
      id={id}
      onClick={onSelect}
      ref={dragRef}
      tabIndex={-1}
    >
      <span className="shrink-0">{icon}</span>
      <span className="min-w-0 flex-1 truncate text-left">{label}</span>
      {badge !== undefined && badge > 0 && (
        <span className="type-ui-sm shrink-0 text-subtle tabular-nums">
          {badge > 99 ? "99+" : badge}
        </span>
      )}
    </button>
  );
}
