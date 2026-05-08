// @pikos/core — pure TS: types, parsers, storage interface
// Zero Tauri / React / DOM dependencies

export * from "./adapters/MockStorageAdapter";
export { parseInput } from "./nlp/parser";
export type { ParseResult, ParsedInput } from "./nlp/parser";
export * from "./storage";
export * from "./types";
export {
  formatDateOnly,
  formatLocalISO,
  localToday,
  nowLocalISO,
  parseLocalISO,
} from "./utils/dates";
export { extractText } from "./utils/extractText";
export {
  buildRrule,
  computeNextEnd,
  expandRecurrenceForRange,
  missedOccurrencesBetween,
  nextOccurrenceAfter,
  parseRrule,
  rruleToLabel,
  rruleToShortLabel,
} from "./utils/recurrence";
export type {
  RecurrenceFreq,
  RecurrenceOptions,
  RecurrenceWeekday,
  VirtualOccurrence,
} from "./utils/recurrence";
export { emojiAwareCompare, stripLeadingEmoji } from "./utils/sort";
