// The wasm binary ships base64-embedded and is instantiated at import time, so every export
// is callable synchronously in any runtime with no loader.

import { initSync } from "./pkg/pikos_recurrence_wasm.js";
import { WASM_BASE64 } from "./pkg/wasm_data.js";

function decodeBase64(b64) {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(b64, "base64");
  }
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

initSync({ module: decodeBase64(WASM_BASE64) });

export {
  alignWeeklyRuleToAnchor,
  buildRrule,
  computeNextEnd,
  expandRange,
  listOccurrences,
  missedOccurrencesBetween,
  nextOccurrenceAfter,
  oldestOpenOccurrence,
  parseRruleOptions,
  rruleToLabel,
  rruleToShortLabel,
  snapAnchorToRule,
} from "./pkg/pikos_recurrence_wasm.js";
