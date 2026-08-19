// Every localStorage key the app persists, spelled once.
//
// The literal values are load-bearing: they name state already sitting in
// users' browsers, so renaming one silently drops the preference it holds.
// `theme` is the single key that predates the `pikos:` namespace and uses a
// hyphen instead of a colon. It stays that way deliberately — and because
// lib/data/deleteAllData.ts sweeps localStorage by STORAGE_KEY_PREFIX, that
// also means "Delete All Data" leaves the theme choice standing. Both
// behaviours are what ships today.

/** Namespace every key but `theme` carries; deleteAllData sweeps on it. */
export const STORAGE_KEY_PREFIX = "pikos:";

export const STORAGE_KEYS = {
  autoUpdateEnabled: "pikos:autoUpdateEnabled",
  calendarAllDayHeight: "pikos:calendarAllDayHeight",
  calendarBottomCollapsed: "pikos:calendarBottomCollapsed",
  calendarBottomHour: "pikos:calendarBottomHour",
  calendarDayCount: "pikos:calendarDayCount",
  calendarDensity: "pikos:calendarDensity",
  calendarReferenceDate: "pikos:calendarReferenceDate",
  calendarsCollapsed: "pikos:calendarsCollapsed",
  calendarScrollHour: "pikos:calendarScrollHour",
  calendarTopCollapsed: "pikos:calendarTopCollapsed",
  calendarTopHour: "pikos:calendarTopHour",
  calendarViewMode: "pikos:calendarViewMode",
  defaultFolderId: "pikos:defaultFolderId",
  defaultReminderMinutes: "pikos:defaultReminderMinutes",
  lastActivePageId: "pikos:lastActivePageId",
  lastActiveViewId: "pikos:lastActiveViewId",
  lastEditorPageId: "pikos:lastEditorPageId",
  leftPanelWidth: "pikos:leftPanelWidth",
  lineWidth: "pikos:lineWidth",
  listDensity: "pikos:listDensity",
  midPanelWidth: "pikos:midPanelWidth",
  notificationsEnabled: "pikos:notificationsEnabled",
  overdueAlerts: "pikos:overdueAlerts",
  overdueCollapsed: "pikos:overdueCollapsed",
  quickAddPlaceholderIndex: "pikos:quickAddPlaceholderIndex",
  quietHoursEnabled: "pikos:quietHoursEnabled",
  quietHoursEnd: "pikos:quietHoursEnd",
  quietHoursStart: "pikos:quietHoursStart",
  rightPanel: "pikos:rightPanel",
  showRelativeDates: "pikos:showRelativeDates",
  sidebarCollapsed: "pikos:sidebarCollapsed",
  skippedVersion: "pikos:skippedVersion",
  sortModes: "pikos:sortModes",
  summaryTime: "pikos:summaryTime",
  /** Outlier: hyphenated, no `pikos:` namespace. See the note above. */
  theme: "pikos-theme",
  weekStart: "pikos:weekStart",
} as const;
