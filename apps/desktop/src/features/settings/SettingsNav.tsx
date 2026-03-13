// SettingsNav — left sidebar navigation for the settings overlay.

import { Settings, Code2, Keyboard, Palette, X } from "lucide-react";
import { cn } from "@/lib/utils";

export type SettingsSection = "general" | "appearance" | "shortcuts" | "developer";

const NAV_ITEMS: { id: SettingsSection; label: string; icon: React.ElementType }[] = [
  { id: "general", label: "General", icon: Settings },
  { id: "appearance", label: "Appearance", icon: Palette },
  { id: "shortcuts", label: "Shortcuts", icon: Keyboard },
  { id: "developer", label: "Developer", icon: Code2 },
];

interface SettingsNavProps {
  active: SettingsSection;
  onNavigate: (section: SettingsSection) => void;
  onClose: () => void;
  width: number;
}

export function SettingsNav({ active, onNavigate, onClose, width }: SettingsNavProps) {
  return (
    <div
      className="flex h-full shrink-0 flex-col border-r border-border bg-background"
      style={{ width }}
    >
      {/* Header */}
      <div className="flex h-11 items-center justify-between border-b border-border px-3">
        <span className="text-xs font-semibold tracking-wider text-muted-foreground uppercase">
          Settings
        </span>
        <button
          onClick={onClose}
          className="rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          aria-label="Close settings"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* Nav items */}
      <nav className="flex-1 overflow-y-auto p-2">
        {NAV_ITEMS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            onClick={() => onNavigate(id)}
            className={cn(
              "flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm transition-colors",
              active === id
                ? "bg-accent font-medium text-accent-foreground"
                : "text-muted-foreground hover:bg-accent/60 hover:text-foreground"
            )}
          >
            <Icon className="h-3.5 w-3.5 shrink-0" />
            {label}
          </button>
        ))}
      </nav>

      {/* Version stamp */}
      <div className="px-3 pt-1 pb-3">
        <p className="text-[10px] text-muted-foreground/50">Pikos — dev build</p>
      </div>
    </div>
  );
}
