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
