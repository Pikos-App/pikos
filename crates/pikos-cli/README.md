# pikos-cli

The Pikos command-line interface and MCP server, in Rust, over the shared `pikos-db` writer. `pikos --help` and `pikos <command> --help` are the reference for commands and flags; this page holds what they don't say.

## How it fits

- **One writer.** Every read and write goes through `pikos-db`, the same code the desktop app uses for schema, FTS triggers, transactions, and ordering. The CLI reimplements none of it.
- **One grammar.** `add` needs the TypeScript Quick Add parser. Porting it to Rust would recreate drift, so the CLI runs the `@pikos/bridge` bundle (`bridge.mjs`) in a one-shot Node subprocess. Only `add` (including `--dry-run`) and the MCP `create_page` tool need Node on PATH.
- **One recurrence engine.** `pikos-recurrence`, the same engine the app runs as wasm.
- **Two front ends, one `ops` layer.** The subcommands and `pikos mcp` both call `ops.rs`. Nothing in the MCP server reaches `pikos-db` directly, so a rule added to an operation holds on both.

## Build and run

```bash
pnpm --filter @pikos/bridge build     # produces packages/pikos-bridge/dist/bridge.mjs
cargo build -p pikos-cli --release    # target/release/pikos
export PIKOS_BRIDGE_JS="$PWD/packages/pikos-bridge/dist/bridge.mjs"
```

A build from source can't find the bridge on its own unless it runs from the repo root, so set `PIKOS_BRIDGE_JS`. A released build needs nothing: the tarball puts the bundle where the binary looks, and the Homebrew formula pins the variable.

A debug build addresses `app.pikos.desktop.dev`, the workspace the dev desktop app writes, so branch work can't reach real data.

## Rules

- **Page bodies are markdown both ways.** `read` prints the body as markdown, and `update --content` writes it back to the same page, using a Rust port of the app's import graded against a corpus the desktop suite generates (`crates/pikos-core/tests/corpus/markdown-import.json`). Anything the editor can't hold, or the app's import would mangle, is refused with a usage error instead of half-written.
- **Section edits touch only what they name.** `update --section <heading>` with `--append`, `--insert`, or `--replace-section` converts only the new markdown and keeps every other block as stored. A heading that is missing or appears twice is refused, listing the headings found.
- **Scheduling never reshapes a page by inference.** `--due` moves, `--all-day` is the only way to drop a time, and `--end` sets the end. A bare date aimed at a timed page is refused. All schedule flags refuse on a recurring or synced page, whose head belongs to the series or the calendar.
- **Delete trashes.** `delete` moves a page to the trash, as the app does, and `restore` undoes it. `delete --hard` destroys it and refuses while the page's calendar is still connected, since the next poll would recreate it. `folders delete` asks first unless `--yes`, because it trashes every page in the folder.
- **Export never overwrites.** `export` writes through the same builders as the app's Settings export, and an `--out` that already exists is refused, so last night's copy survives tonight's.
- **`stress` never touches a real workspace.** It seeds and benchmarks a scratch one.
- **Errors carry a stable `kind` and an exit code.** Foreign (SQLite) error text is never surfaced. The codes are in `src/error.rs`. A script that sees `9` (database file damaged) should stop, not retry: the fix is restoring a backup from the app.

## Schema skew

The CLI shares one workspace file with the installed desktop app, and `open_pool` migrates on connect, so skew is refused in both directions.

- **DB newer than the CLI** fails closed (`SchemaTooNew`, exit 6), so a stale CLI never writes against an unknown schema. A long-lived `pikos mcp` that opened the file before a newer Pikos migrated it refuses every write from then on, with the same kind and both versions named.
- **DB older than the CLI** is refused (exit 8) unless `--migrate` is passed. Migrating is one-way and leaves the installed app unable to open its own workspace until it is updated too.

Never copy or move another file over the workspace while anything has it open, whether the app, the CLI, or an MCP server. The open process reads the new file through its old write-ahead log and memory map, so the next read reports the file malformed, or the process crashes. Restore through the app's backups instead. A raw `sqlite3` write alongside is safe for the file but can't touch pages, because their triggers call functions only Pikos registers.

## MCP server

`pikos mcp` speaks the [Model Context Protocol](https://modelcontextprotocol.io) over stdio, so an agent drives a real workspace through the same code the subcommands use.

```json
{ "mcpServers": { "pikos": { "command": "pikos", "args": ["mcp"] } } }
```

Add `"--db", "/path/to/workspace.sqlite"` to the args to target another workspace. The tools are listed by the server's `tools/list`, each marked read-only or not, so a client can tell a read from a write. Only `update_page` is marked destructive, since its content replaces the whole body; the rest either read or can be taken back by another tool.

Two things the protocol does not offer, so that nothing an agent does is unrecoverable:

- **Hard delete.** `delete_page` only trashes and `restore_page` undoes it. `delete --hard` stays a terminal command.
- **Migration.** `pikos mcp --migrate` is refused, and a workspace behind this build fails the tool call with `MigrationRequired` rather than the handshake, so the client stays connected and reads why. Upgrading the schema locks the installed app out until it is updated, so a person makes that decision at a prompt.

The protocol is hand-rolled rather than taken from an SDK. A stdio server needs only `initialize`, `notifications/initialized`, `tools/list`, and `tools/call` over newline-delimited JSON-RPC 2.0, which is less code than the shim around a crate, and it keeps the CLI's dependencies small.
