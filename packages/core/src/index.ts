// @pikos/core — pure TS: types, parsers, storage interface
// Zero Tauri / React / DOM dependencies

export * from "./adapters/MockStorageAdapter";
export * from "./errors";
export { parseInput } from "./nlp/parser";
export type { ParseResult, ParsedInput } from "./nlp/parser";
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
export { isDone, isOpen } from "./utils/page";
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
} from "./utils/recurrence";
export type {
  RecurrenceFreq,
  RecurrenceOptions,
  RecurrenceWeekday,
  VirtualOccurrence,
} from "./utils/recurrence";
export { emojiAwareCompare, stripLeadingEmoji } from "./utils/sort";
export { resolveSyncedInstant } from "./utils/syncedTime";
export {
  expandRecurrenceInZone,
  normalizeUntilToZone,
  utcToWallClock,
  wallClockToUtc,
} from "./utils/zoned";
export type { ZonedOccurrence } from "./utils/zoned";
