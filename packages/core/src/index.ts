// @pikos/core — pure TS: types, parsers, storage interface
// Zero Tauri / React / DOM dependencies

export * from "./adapters/MockStorageAdapter";
export * from "./errors";
export { parseInput } from "./nlp/parser";
export type { ParseResult, ParsedInput } from "./nlp/parser";
export { buildSearchFilter, parseSearchQuery } from "./nlp/searchQuery";
export type { ParsedSearchQuery, SearchFilterBuild } from "./nlp/searchQuery";
export * from "./storage";
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
