// AppearanceSettings — light / dark / system theme toggle.

import { cn } from "@/lib/utils";
import type { ThemeMode } from "@/shared/context/ThemeContext";
import { useTheme } from "@/shared/context/ThemeContext";

const OPTIONS: { id: ThemeMode; label: string; description: string }[] = [
  { description: "Always use the dark theme.", id: "dark", label: "Dark" },
  { description: "Always use the light theme.", id: "light", label: "Light" },
  {
    description: "Match your OS appearance setting.",
    id: "system",
    label: "System",
  },
];

export function AppearanceSettings() {
  const { mode, setTheme } = useTheme();

  return (
    <div className="max-w-lg">
      <h2 className="mb-1 text-base font-semibold">Appearance</h2>
      <p className="mb-6 text-sm text-muted-foreground">Choose how Pikos looks to you.</p>

      <div className="divide-y divide-border rounded-lg border border-border bg-card">
        {OPTIONS.map((opt) => (
          <button
            className={cn(
              "flex w-full items-center justify-between gap-4 px-4 py-3 text-left transition-colors hover:bg-accent/50",
              mode === opt.id && "bg-accent/40"
            )}
            key={opt.id}
            onClick={() => setTheme(opt.id)}
          >
            <div>
              <p className="text-sm font-medium">{opt.label}</p>
              <p className="text-xs text-muted-foreground">{opt.description}</p>
            </div>
            {/* Radio indicator */}
            <div
              className={cn(
                "h-4 w-4 shrink-0 rounded-full border-2 transition-colors",
                mode === opt.id
                  ? "border-primary bg-primary"
                  : "border-muted-foreground/40 bg-transparent"
              )}
            />
          </button>
        ))}
      </div>
    </div>
  );
}
