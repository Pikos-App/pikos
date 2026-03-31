// AppSettingsContext — app-wide preferences (week start, default folder).
// Persisted to localStorage. Consumed by calendar, Quick Add, and Settings panels.

import { createContext, type ReactNode, useContext } from "react";

import { useLocalStorage } from "@/shared/hooks/useLocalStorage";

// ─── Types ────────────────────────────────────────────────────────────────────

/** 0 = Sunday, 1 = Monday — matches date-fns weekStartsOn. */
export type WeekStart = 0 | 1;

export interface AppSettingsValue {
  weekStart: WeekStart;
  setWeekStart: (v: WeekStart) => void;
  /** Folder ID to use when no folder context exists. null = Inbox. */
  defaultFolderId: string | null;
  setDefaultFolderId: (v: string | null) => void;
}

const AppSettingsContext = createContext<AppSettingsValue | null>(null);

// ─── Provider ─────────────────────────────────────────────────────────────────

export function AppSettingsProvider({ children }: { children: ReactNode }) {
  const [weekStart, setWeekStart] = useLocalStorage<WeekStart>("pikos:weekStart", 1);
  const [defaultFolderId, setDefaultFolderId] = useLocalStorage<string | null>(
    "pikos:defaultFolderId",
    null
  );

  const value: AppSettingsValue = {
    defaultFolderId,
    setDefaultFolderId,
    setWeekStart,
    weekStart,
  };

  return <AppSettingsContext.Provider value={value}>{children}</AppSettingsContext.Provider>;
}

// ─── Hook ─────────────────────────────────────────────────────────────────────
// eslint-disable-next-line react-refresh/only-export-components
export function useAppSettings(): AppSettingsValue {
  const ctx = useContext(AppSettingsContext);
  if (!ctx) throw new Error("useAppSettings must be used within <AppSettingsProvider>");
  return ctx;
}
