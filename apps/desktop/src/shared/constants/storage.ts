// The literal values are load-bearing: they name state already in users' browsers, so renaming
// one silently drops the preference it holds. `theme` predates the `pikos:` namespace and uses a
// hyphen; it stays so, and because deleteAllData sweeps by STORAGE_KEY_PREFIX, "Delete All Data"
// leaves the theme standing.

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
  calendarTextSize: "pikos:calendarTextSize",
  calendarTopCollapsed: "pikos:calendarTopCollapsed",
  calendarTopHour: "pikos:calendarTopHour",
  calendarViewMode: "pikos:calendarViewMode",
  defaultFolderId: "pikos:defaultFolderId",
  defaultReminderMinutes: "pikos:defaultReminderMinutes",
  editorFontSize: "pikos:editorFontSize",
  interfaceTextScale: "pikos:interfaceTextScale",
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
  sidebarCollapsed: "pikos:sidebarCollapsed",
  skippedVersion: "pikos:skippedVersion",
  sortModes: "pikos:sortModes",
  summaryTime: "pikos:summaryTime",
  theme: "pikos-theme",
  weekStart: "pikos:weekStart",
} as const;
