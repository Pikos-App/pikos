/* tslint:disable */
/* eslint-disable */
export function alignWeeklyRuleToAnchor(rrule: string, anchor_start: string): string;
/**
 * Human-readable label ("every week on Monday"), or undefined when the rule
 * can't be reduced to the phrased subset (callers fall back to the raw
 * string).
 */
export function rruleToLabel(rrule: string): string | undefined;
export function computeNextEnd(base_end: string, next_start: string): string | undefined;
/**
 * Next occurrence's scheduledStart strictly after the day of `after`, or
 * undefined when the rule is exhausted or invalid.
 */
export function nextOccurrenceAfter(rrule: string, scheduled_start: string, after: string, exdates_json: string): string | undefined;
/**
 * Typed options as a JSON object (`{freq, interval, byweekday?, bysetpos?,
 * bymonthday?, wkst?, count?, until?}`), or undefined when unparseable or the
 * FREQ is unsupported.
 */
export function parseRruleOptions(rrule: string): string | undefined;
/**
 * Builds an RRULE string from a JSON options object. Returns undefined when
 * the JSON doesn't deserialize into valid options.
 */
export function buildRrule(options_json: string): string | undefined;
/**
 * Compact byline label ("Weekly", "Every 2 weeks × 10"). Falls back to the
 * raw RRULE string on parse failure, mirroring the native helper.
 */
export function rruleToShortLabel(rrule: string): string;
/**
 * First `limit` occurrences anchored at `dtstart`, as a JSON array of local
 * ISO datetimes.
 */
export function listOccurrences(rrule: string, dtstart: string, limit: number): string;
/**
 * Occurrences of a rule within [rangeStart, rangeEnd) as a JSON array of
 * `{originalDate, scheduledStart, scheduledEnd}`.
 */
export function expandRange(rrule: string, scheduled_start: string, scheduled_end: string | null | undefined, range_start: string, range_end: string, exdates_json: string): string;
export function snapAnchorToRule(rrule: string, anchor: string): string;
/**
 * JSON array of YYYY-MM-DD strings strictly between `after` and `before`.
 */
export function missedOccurrencesBetween(rrule: string, scheduled_start: string, after: string, before: string, exdates_json: string): string;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
  readonly memory: WebAssembly.Memory;
  readonly alignWeeklyRuleToAnchor: (a: number, b: number, c: number, d: number, e: number) => void;
  readonly buildRrule: (a: number, b: number, c: number) => void;
  readonly computeNextEnd: (a: number, b: number, c: number, d: number, e: number) => void;
  readonly expandRange: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number, m: number) => void;
  readonly listOccurrences: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
  readonly missedOccurrencesBetween: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number) => void;
  readonly nextOccurrenceAfter: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number) => void;
  readonly parseRruleOptions: (a: number, b: number, c: number) => void;
  readonly rruleToLabel: (a: number, b: number, c: number) => void;
  readonly rruleToShortLabel: (a: number, b: number, c: number) => void;
  readonly snapAnchorToRule: (a: number, b: number, c: number, d: number, e: number) => void;
  readonly __wbindgen_add_to_stack_pointer: (a: number) => number;
  readonly __wbindgen_export_0: (a: number, b: number) => number;
  readonly __wbindgen_export_1: (a: number, b: number, c: number, d: number) => number;
  readonly __wbindgen_export_2: (a: number, b: number, c: number) => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;
/**
* Instantiates the given `module`, which can either be bytes or
* a precompiled `WebAssembly.Module`.
*
* @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
*
* @returns {InitOutput}
*/
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
* If `module_or_path` is {RequestInfo} or {URL}, makes a request and
* for everything else, calls `WebAssembly.instantiate` directly.
*
* @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
*
* @returns {Promise<InitOutput>}
*/
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
