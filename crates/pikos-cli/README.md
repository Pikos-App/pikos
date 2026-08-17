# pikos-cli

The Pikos command-line interface, in Rust, over the shared `pikos-db` writer.

## Architecture

- **DB**: all reads/writes go through `pikos-db` — the _same_ Rust writer the
  desktop app uses (schema, FTS triggers, transactions, sort_order, pragmas).
  One writer, one source of truth; no reimplementation.
- **Parser + recurrence**: `add` and recurring `done` need the TS core's
  `parseInput` / `nextOccurrenceAfter` / `computeNextEnd`. Rather than port that
  rrule/chrono logic to Rust (which would re-create drift), the CLI shells to a
  one-shot Node subprocess — the `@pikos/bridge` bundle (`bridge.mjs`). So NLP +
  recurrence stay single-sourced in TS, the writer stays single-sourced in Rust,
  and nothing is duplicated across languages.
- Read/`status`/`delete`/non-recurring `done` are pure Rust and need no Node.

## Build & run

```bash
# the bridge bundle (needs the JS toolchain; produces packages/pikos-bridge/dist/bridge.mjs)
pnpm --filter @pikos/bridge build

# the CLI binary
cargo build -p pikos-cli --release   # target/release/pikos

# point the CLI at the bridge (until packaging bundles it next to the binary)
export PIKOS_BRIDGE_JS="$PWD/packages/pikos-bridge/dist/bridge.mjs"
pikos add "Email Sam tomorrow 2pm #work !high"
```

Requires Node on PATH for `add` and recurring `done` only.

## Commands

`search`, `read`, `list`, `today`, `add`, `update`, `done`, `status`, `delete`.
Run `pikos <command> --help` for each surface. Global flags: `--json`,
`--db <path>`, `--yes`, `--migrate`.

`delete` moves a page to the trash on every origin, mirroring the app; `--hard`
destroys it instead, and refuses on a page whose calendar is still connected
(the next poll would recreate it).

`update` schedules with three flags, and none of them reshapes a page by
inference. `--due` moves it — `YYYY-MM-DDTHH:MM:SS` for a local time, or
`YYYY-MM-DD` if the page isn't already timed. `--all-day YYYY-MM-DD` is the only
way to drop a time. `--end` sets the end in the page's own shape, and is valid on
its own to extend a page without moving it. A bare date aimed at a timed page is
refused rather than silently converted; a move keeps the length the page had.
All three refuse on a recurring or synced page, whose head belongs to the series
or the calendar.

## Exit codes

`0` ok · `2` usage · `3` not found · `4` conflict · `5` workspace not found ·
`6` schema too new (DB newer than this CLI — upgrade) · `8` migration required
(DB older; re-run with `--migrate`) · `1` other. Foreign (SQLite) error text is
never surfaced; failures carry a stable `kind`.

## Schema skew

Skew is refused in both directions, because the CLI shares one workspace file
with the installed desktop app and `open_pool` migrates on connect.

- **DB newer than the CLI**: the embedded migrator fails closed
  (`VersionMissing` → `SchemaTooNew`, exit 6), so a stale CLI never writes
  against an unknown schema.
- **DB older than the CLI**: refused up front (exit 8) unless `--migrate` is
  passed. Migrating is one-way and would leave the installed app unable to open
  its own workspace until it is updated too.

A debug build addresses `app.pikos.desktop.dev`, the workspace the dev desktop
app writes, so branch work cannot reach real data at all.

## Status

Verified end-to-end here (all commands, `--json`, recurring clone-and-advance,
skew guard). Both the desktop app and this CLI now link `pikos-db` directly —
see `.agent/decisions.md` ("`pikos-db` is the single writer").
