// Pure-logic bridge: exposes the TS core's parser and recurrence math to the
// Rust CLI as a one-shot subprocess. The CLI shells `node bridge.mjs <cmd> <json>`
// and reads one JSON object back. No DB, no side effects — only the two pure
// functions the Rust side can't (and shouldn't) reimplement, so NLP + recurrence
// stay single-sourced in TS while the writer stays single-sourced in pikos-db.
//
// Protocol (argv):
//   parse '<text>'
//     -> { ok: true, result: ParseResult } | { ok: false, error }
//   next-occurrence '{"rrule","scheduledStart","afterDate","exdates?","scheduledEnd?"}'
//     -> { ok: true, next: {scheduledStart,scheduledEnd}|null, nextEnd: string|null }

import { computeNextEnd, nextOccurrenceAfter, parseInput } from "@pikos/core";

function emit(value: unknown): void {
  process.stdout.write(JSON.stringify(value));
}

const cmd = process.argv[2];
const payload = process.argv[3] ?? "";

try {
  if (cmd === "parse") {
    emit({ ok: true, result: parseInput(payload) });
  } else if (cmd === "next-occurrence") {
    const req = JSON.parse(payload) as {
      rrule: string;
      scheduledStart: string;
      afterDate: string;
      exdates?: string[];
      scheduledEnd?: string | null;
    };
    const next = nextOccurrenceAfter(
      req.rrule,
      req.scheduledStart,
      new Date(req.afterDate),
      req.exdates ?? []
    );
    const nextEnd =
      next && req.scheduledEnd ? computeNextEnd(req.scheduledEnd, next.scheduledStart) : null;
    emit({ ok: true, next, nextEnd });
  } else {
    emit({ ok: false, error: `unknown bridge command: ${String(cmd)}` });
    process.exit(2);
  }
} catch (err) {
  emit({ ok: false, error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
}
