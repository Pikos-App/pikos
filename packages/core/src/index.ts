// @pikos/core — pure TS: types, parsers, storage interface
// Zero Tauri / React / DOM dependencies

export * from "./adapters/MockStorageAdapter";
// ── Calendar math: row/block layout, hour↔pixel geometry, grid constants ──
export {
  assignAllDayRows,
  assignStableAllDayRows,
  barPositionStyle,
  buildAllDayBars,
  buildAllDayItems,
  computeAllDayEdgeResize,
  crossingMidnightsCount,
  firstFreeRowInSpan,
  isAllDayPage,
  shiftAllDayEnd,
} from "./calendar/allDayLayout";
export type { AllDayBar, AllDayBarPosition, AllDayItem } from "./calendar/allDayLayout";
export {
  ALL_DAY_BAR_HEIGHT,
  ALL_DAY_ROW_HEIGHT,
  ALL_DAY_TOP_PADDING,
  CASCADE_OFFSET_PCT,
  CHIP_BASE_CLASSES,
  CHIP_STACKED_THRESHOLD,
  CLICK_DELAY,
  COLLAPSED_BAND_HEIGHT,
  COMPACT_BLOCK_HEIGHT,
  COMPACT_MODE_WIDTH_PX,
  DEFAULT_COLLAPSE_CONFIG,
  DEFAULT_EVENT_COLOR,
  DRAG_THRESHOLD,
  GRID_END_HOUR,
  GRID_HEIGHT,
  GRID_START_HOUR,
  HOUR_HEIGHT,
  MAX_BOTTOM_HOUR,
  MAX_TOP_HOUR,
  MAX_VISIBLE_CASCADE_DEPTH,
  MIN_BOTTOM_HOUR,
  MIN_TIMED_MINUTES,
  MIN_TOP_HOUR,
  MIN_VISIBLE_HOURS,
  OVERFLOW_MIN_WIDTH_PX,
  VISIBLE_HOURS,
} from "./calendar/calendarConstants";
export type { CalendarCollapseConfig } from "./calendar/calendarConstants";
export {
  buildCalendarDays,
  buildCollapseGeometry,
  clampBottomHour,
  clampTopHour,
  collapsedBandInnerOffset,
  collapsedBandPillHeight,
  computeCalendarMetrics,
  DEFAULT_METRICS,
  mapDateToY,
  mapHourToY,
  mapYToDate,
  mapYToHour,
  snapY,
  snapYCollapse,
  timeToY,
  weekDays,
  weekEnd,
  weekStart,
  yToDate,
} from "./calendar/calendarGeometry";
export type { CalendarMetrics, CollapseGeometry } from "./calendar/calendarGeometry";
export {
  buildDayBlocks,
  collapseUnderWidth,
  remapBlocksForCollapse,
} from "./calendar/calendarLayout";
export type { CalendarBlock, OverflowPill, RemappedBlocks } from "./calendar/calendarLayout";
export { formatMultiDayTimeRange, formatTimeRange } from "./calendar/calendarTimeFormat";
export { clampDayCount, dayCountColumns, dayCountNavStep } from "./calendar/dayCount";
export type { CalendarDayCount, CalendarDensity } from "./calendar/dayCount";
// ── Shared palettes and priority labels ──
export { defaultColorForProvider, PALETTE_COLORS } from "./constants/colors";
export type { PaletteColor } from "./constants/colors";
export { NLP_PRIORITY_MAP, PRIORITY_COLORS, PRIORITY_LABELS } from "./constants/priorities";
export * from "./errors";
// ── Date/time formatting for chips, labels and pickers ──
export {
  computeEndTimeLabel,
  DAYS_PRESETS,
  DURATION_PRESETS,
  formatDurationLabel,
  formatTimeOfDay,
  formatTriggerLabel,
  parseCustomDurationStr,
  parseCustomTimeStr,
  TIME_SLOTS,
  toISODateOnly,
  toISODateTime,
} from "./format/dateTimePicker";
export type { TimeSlot } from "./format/dateTimePicker";
export { formatDateRange } from "./format/formatDateRange";
export { formatTime12h, formatTime12hParts } from "./format/formatTime";
export {
  formatCompactTime,
  formatLongDate,
  formatPageDate,
  formatPageRelativeTime,
  isDueSoon,
} from "./format/pageDateLabel";
export type { PageDateLabel } from "./format/pageDateLabel";
export { syncedScheduleLabel } from "./format/syncedScheduleLabel";
// ── Import parsers: CSV and markdown vault → ImportPlan ──
export {
  applyMappings,
  detectUniqueValues,
  parseCSV,
  parseDurationToMinutes,
  prepareCSVRows,
  suggestColumnMappings,
  suggestValueMappings,
} from "./import/csv";
export type { PreparedCSV, SuggestedMappings } from "./import/csv";
export {
  extractImageRefs,
  extractWikilinks,
  parseFrontmatter,
  parseMarkdownVault,
  transformCallouts,
} from "./import/markdown";
export type { VaultFile } from "./import/markdown";
export type {
  ColumnMapping,
  CSVMappingConfig,
  ImageRef,
  ImportFolder,
  ImportMeta,
  ImportPage,
  ImportPlan,
  ImportWarning,
  PikosFieldKey,
  ValueMapping,
} from "./import/types";
export { cleanTitle, formatSchedule, formatTimeAgo } from "./import/utils";
// ── Layout: breakpoint modes and the page-list row model ──
export {
  BREAKPOINTS,
  getCalendarDayCount,
  getLayoutMode,
  shouldHideSidebar,
  shouldOverlayPageList,
} from "./layout/breakpoints";
export type { LayoutMode } from "./layout/breakpoints";
export { buildPageListRows } from "./layout/buildPageListRows";
export type {
  BuildPageListRowsInput,
  BuildPageListRowsResult,
  VirtualRow,
} from "./layout/buildPageListRows";
export { parseInput } from "./nlp/parser";
export type { ParseResult, ParsedInput } from "./nlp/parser";
export { buildSearchFilter, parseSearchQuery } from "./nlp/searchQuery";
export type { ParsedSearchQuery, SearchFilterBuild } from "./nlp/searchQuery";
// ── Page list: view scoping, sorting, selection and schedule edits ──
export { folderMoveTargets } from "./pages/folderMoveTargets";
export {
  belongsToView,
  getCompletedTodayPages,
  getCompletedViewPages,
  getVisiblePages,
  groupTodayPages,
  sortPages,
} from "./pages/pageFilters";
export type { SortMode } from "./pages/pageFilters";
export { computeScheduleTransition, normalizeEndInput } from "./pages/schedule";
export { partitionToggleSelection } from "./pages/toggleSelection";
export type { ToggleSelectionGroups } from "./pages/toggleSelection";
export * from "./storage";
// ── Calendar sync health, derived from the read model ──
export { accountConnectionState, calendarSyncDot, STALE_AFTER_MS } from "./sync/syncStatus";
export type { AccountConnectionState, SyncDotMeta, SyncDotState } from "./sync/syncStatus";
export * from "./types";
export {
  dateKey,
  formatDateOnly,
  formatLocalISO,
  getLocalTimezone,
  isAllDayIso,
  isTimedIso,
  localToday,
  nowLocalISO,
  parseLocalISO,
} from "./utils/dates";
export { extractText } from "./utils/extractText";
export { fuzzyMatchFolder } from "./utils/fuzzyMatchFolder";
export {
  deriveTags,
  findRecurringOccurrenceClone,
  isDone,
  isOpen,
  toPageSummary,
} from "./utils/page";
export {
  alignWeeklyRuleToAnchor,
  buildRrule,
  computeNextEnd,
  expandRecurrenceForRange,
  missedOccurrencesBetween,
  nextOccurrenceAfter,
  optionsForFreq,
  optionsWithEnd,
  parseRrule,
  rawExpandRule,
  rruleEditWouldDegrade,
  rruleToLabel,
  rruleToShortLabel,
  snapAnchorToRule,
  snapScheduleToRule,
} from "./utils/recurrence";
export type {
  RecurrenceFreq,
  RecurrenceOptions,
  RecurrenceWeekday,
  VirtualOccurrence,
} from "./utils/recurrence";
export { anchorMoveUpdate, applyAnchorMove, resolveAnchorMove } from "./utils/scheduleAnchor";
export type { AnchorMove } from "./utils/scheduleAnchor";
export { ftsTokens } from "./utils/search";
export { emojiAwareCompare, stripLeadingEmoji } from "./utils/sort";
export { cloneWallClock, resolveSyncedInstant } from "./utils/syncedTime";
export {
  expandRecurrenceInZone,
  normalizeUntilToZone,
  utcToWallClock,
  wallClockToUtc,
} from "./utils/zoned";
export type { ZonedOccurrence } from "./utils/zoned";
