import { useEffect } from "react";

import { STORAGE_KEYS } from "@/shared/constants/storage";
import { createSettingsContext } from "@/shared/context/createSettingsContext";
import { useLocalStorage } from "@/shared/hooks/useLocalStorage";
import { getPlatform } from "@/shared/platform";

/** 0 = Sunday, 1 = Monday — matches date-fns weekStartsOn. */
export type WeekStart = 0 | 1;

/** Reminder lead time options in minutes. 0 = "at start time"; the longer end
 *  (60 / 120 / 1440) is what the schema always accepted — the pickers just never
 *  offered it — and the scheduler's arms do the date arithmetic in SQLite, so a
 *  lead that crosses midnight fires on the right day. */
export type ReminderLeadTime = 0 | 5 | 10 | 15 | 30 | 60 | 120 | 1440;

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
  /** Run the auto-updater check on launch. Default: true. Manual re-check works regardless. */
  autoUpdateEnabled: boolean;
  setAutoUpdateEnabled: (v: boolean) => void;
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

function useAppSettingsValue(): AppSettingsValue {
  const [weekStart, setWeekStart] = useLocalStorage<WeekStart>(STORAGE_KEYS.weekStart, 1);
  const [defaultFolderId, setDefaultFolderId] = useLocalStorage<string | null>(
    STORAGE_KEYS.defaultFolderId,
    null
  );
  const [notificationsEnabled, setNotificationsEnabled] = useLocalStorage<boolean>(
    STORAGE_KEYS.notificationsEnabled,
    true
  );
  const [defaultReminderMinutes, setDefaultReminderMinutes] = useLocalStorage<ReminderLeadTime>(
    STORAGE_KEYS.defaultReminderMinutes,
    10
  );
  const [skippedVersion, setSkippedVersion] = useLocalStorage<string | null>(
    STORAGE_KEYS.skippedVersion,
    null
  );
  const [autoUpdateEnabled, setAutoUpdateEnabled] = useLocalStorage<boolean>(
    STORAGE_KEYS.autoUpdateEnabled,
    true
  );
  const [overdueAlerts, setOverdueAlerts] = useLocalStorage<boolean>(
    STORAGE_KEYS.overdueAlerts,
    true
  );
  const [summaryTime, setSummaryTime] = useLocalStorage<string>(STORAGE_KEYS.summaryTime, "07:00");
  const [quietHoursEnabled, setQuietHoursEnabled] = useLocalStorage<boolean>(
    STORAGE_KEYS.quietHoursEnabled,
    false
  );
  const [quietHoursStart, setQuietHoursStart] = useLocalStorage<string>(
    STORAGE_KEYS.quietHoursStart,
    "22:00"
  );
  const [quietHoursEnd, setQuietHoursEnd] = useLocalStorage<string>(
    STORAGE_KEYS.quietHoursEnd,
    "08:00"
  );

  // Sync notification settings to the host scheduler whenever they change.
  // Wrapped in catch — the no-op platform resolves, but a real host can still
  // reject (scheduler not started yet), and a settings toggle must not throw.
  useEffect(() => {
    void getPlatform()
      .applyNotificationSettings({
        defaultMinutesBefore: defaultReminderMinutes,
        enabled: notificationsEnabled,
        overdueAlerts,
        quietHoursEnabled,
        quietHoursEnd,
        quietHoursStart,
        summaryTime,
      })
      .catch(() => {
        // Host scheduler unavailable — settings still persist locally.
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

  return {
    autoUpdateEnabled,
    defaultFolderId,
    defaultReminderMinutes,
    notificationsEnabled,
    overdueAlerts,
    quietHoursEnabled,
    quietHoursEnd,
    quietHoursStart,
    setAutoUpdateEnabled,
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
}

const appSettings = createSettingsContext("AppSettings", useAppSettingsValue);

export const AppSettingsProvider = appSettings.Provider;
export const useAppSettings = appSettings.useSettings;
