# pikos-cli

The Pikos command-line interface, in Rust, over the shared `pikos-db` writer.

## Architecture

- **DB**: all reads/writes go through `pikos-db` — the _same_ Rust writer the
  desktop app uses (schema, FTS triggers, transactions, sort_order, pragmas).
  One writer, one source of truth; no reimplementation.
- **Parser**: `add` needs the TS core's `parseInput`. Rather than port the
  natural-language grammar to Rust (which would re-create drift), the CLI shells
  to a one-shot Node subprocess — the `@pikos/bridge` bundle (`bridge.mjs`). So
  the grammar stays single-sourced in TS and the writer in Rust.
- **Recurrence** is the shared `pikos-recurrence` engine the app runs as wasm, so
  recurring `done` and the `occurrence` commands are pure Rust like everything
  else but `add`.
- **Layout**: `cli.rs` (clap surface) → `commands.rs` (dispatch) → `ops.rs` (the
  operations, in pikos-db terms) → `render.rs` (plain text). `workspace.rs`
  resolves and gates the DB file, `bridge.rs` runs the parser subprocess,
  `schedule.rs` reads and resolves schedule shapes, `write.rs` holds the writes
  that mirror the app's persistence path, `occurrences.rs` handles one occurrence
  of a repeating page, and `mcp.rs` is a second front end onto `ops.rs`.

## Build & run

```bash
# the bridge bundle (needs the JS toolchain; produces packages/pikos-bridge/dist/bridge.mjs)
pnpm --filter @pikos/bridge build

# the CLI binary
cargo build -p pikos-cli --release   # target/release/pikos

# point the CLI at the bridge, which a build from source cannot find on its own
# unless it is run from the repo root
export PIKOS_BRIDGE_JS="$PWD/packages/pikos-bridge/dist/bridge.mjs"
pikos add "Email Sam tomorrow 2pm #work !high"
```

A released build needs none of that: the tarball puts the bundle where the binary
already looks, and the Homebrew formula pins the variable anyway.

Requires Node on PATH for `add` (including `--dry-run`) only.

## Commands

`search`, `read`, `list`, `today`, `add`, `update`, `done`, `status`, `delete`,
`restore`, `trash`, `tags`, `folders`, `occurrence`, `reminders`, `mcp`, `stress`.
Run `pikos <command> --help` for each surface. Global flags: `--json`,
`--db <path>`, `--yes`, `--migrate`.

`search` ranks matches the way the app does and shows `--limit` of them (default 20). When
there are more it prints a cursor, and `--after <cursor>` shows the next page. Each page ranks
the newest 2,000 matches past the cursor, so a word in most of a large workspace still answers in
milliseconds. A page must hold every word; when none does, the search falls back to any of
them and says so, and `--any` asks for that up front. Done pages are left out unless
`--include-completed`.

`list` takes the whole page filter: `--status`, `--priority 0..4`, `--tag`
(repeatable, all must match), `--due <day>` or `--due <from>..<to>`,
`--folder <name-or-id>` (fuzzy, like `add ~folder`; `inbox` means unfiled when no
folder is named for it), `--query <text>` over titles and bodies,
`--has-schedule`, `--created` and `--completed` (a day or a `<from>..<to>` range),
`--repeating` and `--has-reminders` (each also prints the rule or the lead), plus
`--modified` or `--oldest-first` to sort and `--limit`.

`add` reads the same grammar Quick Add does, reminders and bodies included:
`remind 30m before` / `remind me 2 hours before` / `!r30`, `!r1h`, `!r1d` set the
lead, and `remind day before` asks for the morning-before anchor. A lead only
sticks when the text also names a schedule — nothing else could anchor it — and
an all-day page takes the day-before anchor whatever lead was typed, since it has
no start time to count minutes back from. Everything after the first `//` that
has whitespace on both sides becomes the page body, as markdown — no tag, date or
cadence is read out of it, and a URL's slashes never split anything.

Page bodies are markdown both ways. `read` shows the body as markdown, and
`--json` adds a `markdown` field beside the stored document; `update --content`
takes markdown and replaces the whole body. The two are made to meet: what `read`
prints, `update --content` writes back to the same page. Markdown is read the way
the app's import reads it, by a Rust port graded against a corpus the desktop
suite generates from the app's own converter
(`crates/pikos-core/tests/corpus/markdown-import.json`). What the editor can't
hold, or what the app's import would mangle, is refused with a usage error rather
than half-written: raw HTML, an image inside a line of text, a list mixing tasks
and plain items, a numbered task list, a heading inside a list item, and code
inside a link.

To change part of a page, `update --section <heading>` names a heading by its
text, and `--append`, `--insert` or `--replace-section` takes the markdown that
goes at the end of that section, straight under its heading, or in place of what
is under it, up to the next heading of the same or a higher level. `--append`
alone adds to the end of the page. Only the new markdown is converted; every
other block is kept exactly as stored, so a part markdown can't carry survives,
and an edit that changes nothing writes nothing. A heading that isn't on the page,
or is there twice, is refused with the headings it found. Over MCP the same edits
are `update_page`'s `section`, `append`, `insert` and `replaceSection`.

`add --dry-run` runs the parser and prints what it made of the text — the exact
shape `add` would then persist — without writing. It is the agent-preview mode:
show the parse, then re-issue the same text to commit it.

`delete` moves a page to the trash on every origin, mirroring the app; `--hard`
destroys it instead, and refuses on a page whose calendar is still connected
(the next poll would recreate it). `restore <id>` is the other half — it brings a
trashed page back and hands a tombstoned mirror back to the reconciler. `trash`
lists what is in the trash, newest first, so a page can be restored without
already holding its id. `tags` lists the tags on open pages, most used first.

`folders list` prints every folder with its live page count; `folders create
<name>` makes one at the top level. `folders rename <folder> <name>` and `folders
delete <folder>` take an id or the folder's whole name, never a prefix, because
`delete` trashes every page in the folder; it asks first unless `--yes`. `folders
restore <id>` brings the folder back with the pages that went with it. A folder
that mirrors a calendar refuses both. Folders don't nest in Pikos, so nothing here
sets a parent.

`done` on a repeating page marks its oldest open occurrence done; `done --date
<YYYY-MM-DD>` names one. On a series from a connected calendar that can be any
open occurrence since the calendar was connected, recorded at the time the app
shows it. A series made in Pikos is always completed from its oldest open
occurrence, so there `--date` may only name that one.

`occurrence skip <page-id> <date>` and `occurrence unskip` dismiss one
occurrence of a repeating page and bring it back. `occurrence move <page-id>
<date> --due <when>` moves one, reading `--due`, `--all-day` and `--end` as
`update` does against that occurrence's own time, so it keeps its length; in a
series made in Pikos the moved occurrence becomes a page of its own, as a drag
on the calendar makes it. The date must be one the rule gives. `status <id>
not_started` on the done page a completed occurrence left gives the date back
to its series, as unchecking it in the app does.

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

`update --folder <name-or-id>` refiles a page, resolved as `list --folder` resolves it,
so `inbox` unfiles it when no folder is named for it. A calendar folder takes no
pages, and a synced page stays in its calendar's folder.

`--tag` and `--untag` (each repeatable) add and remove tags, matched as the app
stores them: lowercase, with Quick Add's `#` dropped. `--subtitle` sets the line
under the title, and `--subtitle ""` clears it. `--unschedule` removes the date
and time, and `--no-end` drops the end and keeps the start; both refuse on a
recurring or synced page, like the three schedule flags.

`stress seed` fills a scratch workspace with generated pages, and `stress bench`
times the operations that decide whether Pikos feels instant against it. Neither
touches your real workspace.

## Exit codes

`0` ok · `2` usage · `3` not found · `4` conflict · `5` workspace not found ·
`6` schema too new (DB newer than this CLI — upgrade) · `7` node missing ·
`8` migration required (DB older; re-run with `--migrate`) · `9` database file
damaged (restore a backup from the app) · `1` other. Foreign (SQLite) error text
is never surfaced; failures carry a stable `kind`.

## Schema skew

Skew is refused in both directions, because the CLI shares one workspace file
with the installed desktop app and `open_pool` migrates on connect.

- **DB newer than the CLI**: the embedded migrator fails closed
  (`VersionMissing` → `SchemaTooNew`, exit 6), so a stale CLI never writes
  against an unknown schema. A long-lived `pikos mcp` that opened the file
  before a newer Pikos migrated it refuses every write from then on, with the
  same kind and both versions named.

Never copy or move another file over the workspace while anything has it open,
whether the app, the CLI or an MCP server. The open process reads the new file
through its old write-ahead log and memory map: the next read reports the file
malformed, or the process crashes. A raw `sqlite3` write alongside is safe for
the file, but cannot touch pages: their triggers call functions only Pikos
registers. Restore through the app's backups instead.
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
than the default one.

`create_page` is the one tool that needs Node on PATH and the parser bridge, both
covered under **Build & run** — an installed build resolves the bridge itself, so
there is nothing to set. Every other tool is DB-only.

Tools: `search_pages`, `read_page`, `list_pages` (the full filter set above),
`create_page` (natural language, plus `dryRun` to preview the parse),
`update_page`, `set_status`, `complete_page`, `skip_occurrence`,
`unskip_occurrence`, `move_occurrence`, `delete_page`, `restore_page`, `list_trash`, `list_tags`, `list_folders`, `create_folder`, `rename_folder`, `delete_folder`,
`restore_folder`, `list_reminders`, `add_reminder`, `remove_reminder`.

Two things the protocol deliberately does not offer. **Hard delete**:
`delete_page` only trashes, and `restore_page` undoes it, so nothing an agent
does over MCP is unrecoverable. `delete --hard` stays a terminal-only command,
and an agent with shell access can still run it. **Migration**: `pikos mcp --migrate` is refused outright,
and a workspace behind this build fails the _tool call_ with a
`MigrationRequired` error rather than the handshake — the client stays connected
and reads why. Upgrading the schema is one-way and locks the installed app out
until it is updated too, so it stays a decision a person makes at a prompt.

The protocol is hand-rolled rather than taken from an SDK: a stdio server needs
`initialize`, `notifications/initialized`, `tools/list` and `tools/call` over
newline-delimited JSON-RPC 2.0, which is less code than the shim around a crate
would be, and it keeps the CLI's dependencies to what it already had.

## Not exposed

Left out on purpose: export lives in the desktop crate, sync needs credentials
and the keyring, and editing a recurrence rule is a larger design than a flag.
