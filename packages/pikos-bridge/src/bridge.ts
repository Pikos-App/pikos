// Exposes the TS core's NL parser to the Rust CLI as a one-shot subprocess, so NLP stays
// single-sourced in TS. No DB, no side effects.
//
// Protocol (argv):
//   parse '<text>'
//     -> { ok: true, result: ParseResult } | { ok: false, error }

import { parseInput } from "@pikos/core";

function emit(value: unknown): void {
  process.stdout.write(JSON.stringify(value));
}

const cmd = process.argv[2];
const payload = process.argv[3] ?? "";

try {
  if (cmd === "parse") {
    emit({ ok: true, result: parseInput(payload) });
  } else {
    emit({ ok: false, error: `unknown bridge command: ${String(cmd)}` });
    process.exit(2);
  }
} catch (err) {
  emit({ ok: false, error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
}
