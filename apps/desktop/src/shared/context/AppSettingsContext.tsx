import { useEffect } from "react";

import { STORAGE_KEYS } from "@/shared/constants/storage";
import { createSettingsContext } from "@/shared/context/createSettingsContext";
import { postNotice } from "@/shared/events/noticeBus";
import { useLocalStorage } from "@/shared/hooks/useLocalStorage";
import { getPlatform } from "@/shared/platform";

export type WeekStart = 0 | 1;

/** Reminder lead time options in minutes. 0 = "at start time". The scheduler's arms do the date
 *  arithmetic in SQLite, so a lead that crosses midnight fires on the right day. */
export type ReminderLeadTime = 0 | 5 | 10 | 15 | 30 | 60 | 120 | 1440;

export interface AppSettingsValue {
  weekStart: WeekStart;
  setWeekStart: (v: WeekStart) => void;
  /** Folder ID to use when no folder context exists. null = Inbox. */
  defaultFolderId: string | null;
  setDefaultFolderId: (v: string | null) => void;
  notificationsEnabled: boolean;
  setNotificationsEnabled: (v: boolean) => void;
  defaultReminderMinutes: ReminderLeadTime;
  setDefaultReminderMinutes: (v: ReminderLeadTime) => void;
  /** Version string the user chose to skip (e.g. "1.2.0"). null = no skip. */
  skippedVersion: string | null;
  setSkippedVersion: (v: string | null) => void;
  /** Run the auto-updater check on launch. A manual re-check works regardless. */
  autoUpdateEnabled: boolean;
  setAutoUpdateEnabled: (v: boolean) => void;
  overdueAlerts: boolean;
  setOverdueAlerts: (v: boolean) => void;
  /** Time of day the daily summary fires (HH:MM, 24h). Deferred if inside quiet hours. */
  summaryTime: string;
  setSummaryTime: (v: string) => void;
  quietHoursEnabled: boolean;
  setQuietHoursEnabled: (v: boolean) => void;
  quietHoursStart: string;
  setQuietHoursStart: (v: string) => void;
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

  // The no-op platform resolves, but a real host can reject (scheduler not started yet), and a
  // settings toggle must not throw.
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
        // The settings persist locally either way, so the panel goes on showing reminders as on while
        // nothing is scheduled to fire; a reminder that never arrives looks like one never set.
        postNotice("Saved, but reminders may not fire until you restart Pikos.");
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
