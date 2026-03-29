// AppearanceSettings — light / dark / system theme toggle.

import { useEffect, useState } from "react";

import { cn } from "@/lib/utils";

type ThemeMode = "dark" | "light" | "system";

function applyTheme(mode: ThemeMode) {
  const root = document.documentElement;
  // Brief transition class to smooth the theme switch
  root.classList.add("theme-transitioning");
  if (mode === "system") {
    const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    root.classList.toggle("dark", prefersDark);
  } else {
    root.classList.toggle("dark", mode === "dark");
  }
  setTimeout(() => root.classList.remove("theme-transitioning"), 250);
}

function readTheme(): ThemeMode {
  const t = localStorage.getItem("pikos-theme");
  if (t === "light" || t === "system") return t;
  return "dark";
}

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
  const [mode, setMode] = useState<ThemeMode>(readTheme);

  // Keep in sync with OS preference changes when mode is "system"
  useEffect(() => {
    if (mode !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = () => applyTheme("system");
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, [mode]);

  function select(next: ThemeMode) {
    setMode(next);
    localStorage.setItem("pikos-theme", next);
    applyTheme(next);
  }

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
            onClick={() => select(opt.id)}
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
