// Pure-logic bridge: exposes the TS core's NL parser to the Rust CLI as a
// one-shot subprocess. The CLI shells `node bridge.mjs parse '<text>'` and
// reads one JSON object back. No DB, no side effects — only the one pure
// function the Rust side can't (and shouldn't) reimplement, so NLP stays
// single-sourced in TS while the writer stays single-sourced in pikos-db.
// (Recurrence math used to be bridged too; it now lives in the shared Rust
// engine — crates/pikos-recurrence — which the CLI links natively.)
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
