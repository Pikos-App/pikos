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
  /** Global on/off switch for desktop notifications. Default: true. */
  notificationsEnabled: boolean;
  setNotificationsEnabled: (v: boolean) => void;
  /** Default reminder lead time for pages without per-page reminders. Default: 10. */
  defaultReminderMinutes: ReminderLeadTime;
  setDefaultReminderMinutes: (v: ReminderLeadTime) => void;
  /** Version string the user chose to skip (e.g. "1.2.0"). null = no skip. */
  skippedVersion: string | null;
  setSkippedVersion: (v: string | null) => void;
  /** Daily summary — fire once per day with today + overdue counts. Default: true. */
  overdueAlerts: boolean;
  setOverdueAlerts: (v: boolean) => void;
  /** Time of day the daily summary fires (HH:MM, 24h). Deferred if inside quiet hours. Default: "07:00". */
  summaryTime: string;
  setSummaryTime: (v: string) => void;
  /** Quiet hours — suppress notifications during a time window. Default: off. */
  quietHoursEnabled: boolean;
  setQuietHoursEnabled: (v: boolean) => void;
  /** Quiet hours start time (HH:MM, 24h format). Default: "22:00". */
  quietHoursStart: string;
  setQuietHoursStart: (v: string) => void;
  /** Quiet hours end time (HH:MM, 24h format). Default: "08:00". */
  quietHoursEnd: string;
  setQuietHoursEnd: (v: string) => void;
}

const AppSettingsContext = createContext<AppSettingsValue | null>(null);

// ─── Provider ─────────────────────────────────────────────────────────────────

export function AppSettingsProvider({ children }: { children: ReactNode }) {
  const [weekStart, setWeekStart] = useLocalStorage<WeekStart>("pikos:weekStart", 1);
  const [defaultFolderId, setDefaultFolderId] = useLocalStorage<string | null>(
    "pikos:defaultFolderId",
    null
  );
  const [notificationsEnabled, setNotificationsEnabled] = useLocalStorage<boolean>(
    "pikos:notificationsEnabled",
    true
  );
  const [defaultReminderMinutes, setDefaultReminderMinutes] = useLocalStorage<ReminderLeadTime>(
    "pikos:defaultReminderMinutes",
    10
  );
  const [skippedVersion, setSkippedVersion] = useLocalStorage<string | null>(
    "pikos:skippedVersion",
    null
  );
  const [overdueAlerts, setOverdueAlerts] = useLocalStorage<boolean>("pikos:overdueAlerts", true);
  const [summaryTime, setSummaryTime] = useLocalStorage<string>("pikos:summaryTime", "07:00");
  const [quietHoursEnabled, setQuietHoursEnabled] = useLocalStorage<boolean>(
    "pikos:quietHoursEnabled",
    false
  );
  const [quietHoursStart, setQuietHoursStart] = useLocalStorage<string>(
    "pikos:quietHoursStart",
    "22:00"
  );
  const [quietHoursEnd, setQuietHoursEnd] = useLocalStorage<string>("pikos:quietHoursEnd", "08:00");

  // Sync notification settings to the Rust scheduler whenever they change.
  // Wrapped in catch — Tauri IPC is unavailable in test/non-Tauri environments.
  useEffect(() => {
    if (import.meta.env["VITE_TEST_MODE"] === "true") return;
    void import("@tauri-apps/api/core")
      .then(({ invoke }) =>
        invoke("update_notification_settings", {
          settings: {
            defaultMinutesBefore: defaultReminderMinutes,
            enabled: notificationsEnabled,
            overdueAlerts,
            quietHoursEnabled,
            quietHoursEnd,
            quietHoursStart,
            summaryTime,
          },
        })
      )
      .catch(() => {
        // Tauri runtime not available (test environment)
      });
  }, [
    notificationsEnabled,
    defaultReminderMinutes,
    overdueAlerts,
    summaryTime,
    quietHoursEnabled,
    quietHoursStart,
    quietHoursEnd,
  ]);

  const value: AppSettingsValue = {
    defaultFolderId,
    defaultReminderMinutes,
    notificationsEnabled,
    overdueAlerts,
    quietHoursEnabled,
    quietHoursEnd,
    quietHoursStart,
    setDefaultFolderId,
    setDefaultReminderMinutes,
    setNotificationsEnabled,
    setOverdueAlerts,
    setQuietHoursEnabled,
    setQuietHoursEnd,
    setQuietHoursStart,
    setSkippedVersion,
    setSummaryTime,
    setWeekStart,
    skippedVersion,
    summaryTime,
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
