// AppSettingsContext — app-wide preferences (week start, default folder, notifications).
// Persisted to localStorage. Consumed by calendar, Quick Add, Settings panels, and scheduler.

import { createContext, type ReactNode, useContext, useEffect } from "react";

import { useLocalStorage } from "@/shared/hooks/useLocalStorage";

// ─── Types ────────────────────────────────────────────────────────────────────

/** 0 = Sunday, 1 = Monday — matches date-fns weekStartsOn. */
export type WeekStart = 0 | 1;

/** Reminder lead time options in minutes. 0 = "at start time". */
export type ReminderLeadTime = 0 | 5 | 10 | 15 | 30;

export interface AppSettingsValue {
  weekStart: WeekStart;
  setWeekStart: (v: WeekStart) => void;
  /** Folder ID to use when no folder context exists. null = Inbox. */
  defaultFolderId: string | null;
  setDefaultFolderId: (v: string | null) => void;
  /** Whether to automatically check for updates on launch. Default: true. */
  autoCheckUpdates: boolean;
  setAutoCheckUpdates: (v: boolean) => void;
  /** Global on/off switch for desktop notifications. Default: true. */
  notificationsEnabled: boolean;
  setNotificationsEnabled: (v: boolean) => void;
  /** Default reminder lead time for pages without per-page reminders. Default: 10. */
  defaultReminderMinutes: ReminderLeadTime;
  setDefaultReminderMinutes: (v: ReminderLeadTime) => void;
}

const AppSettingsContext = createContext<AppSettingsValue | null>(null);

// ─── Provider ─────────────────────────────────────────────────────────────────

export function AppSettingsProvider({ children }: { children: ReactNode }) {
  const [weekStart, setWeekStart] = useLocalStorage<WeekStart>("pikos:weekStart", 1);
  const [defaultFolderId, setDefaultFolderId] = useLocalStorage<string | null>(
    "pikos:defaultFolderId",
    null
  );
  const [autoCheckUpdates, setAutoCheckUpdates] = useLocalStorage<boolean>(
    "pikos:autoCheckUpdates",
    true
  );
  const [notificationsEnabled, setNotificationsEnabled] = useLocalStorage<boolean>(
    "pikos:notificationsEnabled",
    true
  );
  const [defaultReminderMinutes, setDefaultReminderMinutes] = useLocalStorage<ReminderLeadTime>(
    "pikos:defaultReminderMinutes",
    10
  );

  // Sync notification settings to the Rust scheduler whenever they change.
  // Wrapped in try/catch — Tauri IPC is unavailable in test/non-Tauri environments.
  useEffect(() => {
    if (import.meta.env["VITE_TEST_MODE"] === "true") return;
    void import("@tauri-apps/api/core")
      .then(({ invoke }) =>
        invoke("update_notification_settings", {
          settings: {
            defaultMinutesBefore: defaultReminderMinutes,
            enabled: notificationsEnabled,
          },
        })
      )
      .catch(() => {
        // Tauri runtime not available (test environment)
      });
  }, [notificationsEnabled, defaultReminderMinutes]);

  const value: AppSettingsValue = {
    autoCheckUpdates,
    defaultFolderId,
    defaultReminderMinutes,
    notificationsEnabled,
    setAutoCheckUpdates,
    setDefaultFolderId,
    setDefaultReminderMinutes,
    setNotificationsEnabled,
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
