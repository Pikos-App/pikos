import { cn } from "@/lib/utils";

interface SmartViewEntryProps {
  label: string;
  icon: React.ReactNode;
  isActive: boolean;
  onSelect: () => void;
}

export function SmartViewEntry({ label, icon, isActive, onSelect }: SmartViewEntryProps) {
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
      {label}
    </button>
  );
}
