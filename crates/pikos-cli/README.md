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
- Read/`status`/`rm`/non-recurring `done` are pure Rust and need no Node.

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

`search`, `read`, `list`, `today`, `add`, `update`, `done`, `status`, `rm` —
same surface and `--json` contract as documented in `apps/cli/README.md`. Global
flags: `--json`, `--db <path>`, `--yes`.

## Exit codes

`0` ok · `2` usage · `3` not found · `4` conflict · `5` workspace not found ·
`6` schema too new (DB newer than this CLI — upgrade) · `1` other. Foreign
(SQLite) error text is never surfaced; failures carry a stable `kind`.

## Schema skew

`open_pool` runs the embedded migrator, which fails closed (`VersionMissing` →
`SchemaTooNew`, exit 6) when the workspace DB is at a newer migration than this
build — so a stale CLI can never write against an unknown schema.

## Status

Verified end-to-end here (all commands, `--json`, recurring clone-and-advance,
skew guard). Both the desktop app and this CLI now link `pikos-db` directly —
see `.agent/decisions.md` ("`pikos-db` is the single writer").
