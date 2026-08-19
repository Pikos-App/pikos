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
- **Layout**: `cli.rs` (clap surface) → `commands.rs` (dispatch) → `ops.rs` (the
  operations, in pikos-db terms) → `render.rs` (plain text). `workspace.rs`
  resolves and gates the DB file, `bridge.rs` runs the parser subprocess,
  `schedule.rs` reads and resolves schedule shapes, `write.rs` holds the writes
  that mirror the app's persistence path, and `mcp.rs` is a second front end onto
  `ops.rs`.

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

Requires Node on PATH for `add` (including `--dry-run`) and recurring `done`
only.

## Commands

`search`, `read`, `list`, `today`, `add`, `update`, `done`, `status`, `delete`,
`restore`, `folders`, `reminders`, `mcp`. Run `pikos <command> --help` for each
surface. Global flags: `--json`, `--db <path>`, `--yes`, `--migrate`.

`list` takes the whole page filter: `--status`, `--priority 0..4`, `--tag`
(repeatable, all must match), `--due <day>` or `--due <from>..<to>`,
`--folder <name-or-id>` (fuzzy, like `add ~folder`; `inbox` means unfiled when no
folder is named for it), `--query <text>` over titles and bodies,
`--has-schedule`, plus `--modified` and `--limit`.

`add --dry-run` runs the parser and prints what it made of the text — the exact
shape `add` would then persist — without writing. It is the agent-preview mode:
show the parse, then re-issue the same text to commit it.

`delete` moves a page to the trash on every origin, mirroring the app; `--hard`
destroys it instead, and refuses on a page whose calendar is still connected
(the next poll would recreate it). `restore <id>` is the other half — it brings a
trashed page back and hands a tombstoned mirror back to the reconciler.

`folders list` prints every folder with its live page count; `folders create
<name>` makes one at the top level.

`reminders list <page-id>`, `reminders add <page-id> --minutes <n>` and
`reminders rm <reminder-id>` manage per-page reminders. `--minutes` counts back
from the scheduled start: `0` fires at the start, and `-1` is the "no reminders
for this page" sentinel.

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

## MCP server

`pikos mcp` speaks the [Model Context Protocol](https://modelcontextprotocol.io)
over stdio, so an agent can drive a real workspace through the same code the
subcommands use — every tool is a thin arm over the shared `ops` layer, and
nothing in the server reaches `pikos-db` directly.

```json
{
  "mcpServers": {
    "pikos": { "command": "pikos", "args": ["mcp"] }
  }
}
```

Add `"--db", "/path/to/workspace.sqlite"` to the args to target a workspace other
than the default one, and `"env": { "PIKOS_BRIDGE_JS": "…/bridge.mjs" }` until
packaging puts the bridge next to the binary (`create_page` needs it; every other
tool is DB-only).

Tools: `search_pages`, `read_page`, `list_pages` (the full filter set above),
`create_page` (natural language, plus `dryRun` to preview the parse),
`update_page`, `set_status`, `complete_page`, `delete_page`, `restore_page`,
`list_folders`, `list_reminders`, `add_reminder`, `remove_reminder`.

Two things the protocol deliberately does not offer. **Hard delete**:
`delete_page` only trashes, and `restore_page` undoes it, so nothing an agent
does is unrecoverable. **Migration**: `pikos mcp --migrate` is refused outright,
and a workspace behind this build fails the *tool call* with a
`MigrationRequired` error rather than the handshake — the client stays connected
and reads why. Upgrading the schema is one-way and locks the installed app out
until it is updated too, so it stays a decision a person makes at a prompt.

The protocol is hand-rolled rather than taken from an SDK: a stdio server needs
`initialize`, `notifications/initialized`, `tools/list` and `tools/call` over
newline-delimited JSON-RPC 2.0, which is less code than the shim around a crate
would be, and it keeps the CLI's dependencies to what it already had.

## Status

Verified end-to-end here (all commands, `--json`, recurring clone-and-advance,
skew guard, and an MCP client driving a temp workspace over stdio). Both the
desktop app and this CLI now link `pikos-db` directly — see `.agent/decisions.md`
("`pikos-db` is the single writer").

Not exposed on purpose: export lives in the desktop crate, sync needs credentials
and the keyring, and editing a recurrence rule is a larger design than a flag.
