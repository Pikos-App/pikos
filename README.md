<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="apps/brand/svg/pikos-dark.svg">
    <img src="apps/brand/svg/pikos-light.svg" alt="Pikos" width="128" height="128">
  </picture>
</p>

# Pikos

Notes, tasks, and calendar. One app, on your computer.

Pikos is a desktop app for macOS and Linux where a note, a task, and a calendar event are the same page. No account, no subscription, and no Pikos server. Your data is a SQLite file on your machine.

AI never gets in your way: Pikos opens to your page, not a chat box. If you want AI help, an MCP server ships with it, so the assistant you already use can search, read, and write your notes. Pikos itself sends nothing anywhere; a cloud assistant sends what it reads to its provider, and a local model keeps everything on your machine.

**[Website](https://pikos.app)** &middot; **[Download](https://pikos.app/download)** &middot; **[Blog](https://pikos.app/blog)**

## Features

- **Rich text editor.** Headings, bold, italic, checklists, code blocks, blockquotes. Slash commands, format toolbar, Markdown paste support.
- **Task management.** Status tracking, four-level priority, tags, smart views (Today, Inbox), drag-and-drop reordering.
- **Built-in calendar.** One to seven days, or a month, alongside the editor. Drag pages to schedule them. Click a time slot to create a page.
- **Calendar sync.** Read-only, opt-in sync from iCloud, Google Calendar, or any CalDAV server. Your events arrive as pages you can take notes on. Nothing you write is sent back, and credentials go to the OS keychain.
- **Full-text search.** FTS5-powered search across all page content, with ranked results and previews.
- **Quick capture.** Natural language input: "Call dentist tomorrow high priority #health" creates a page with title, date, priority, and tag set automatically.
- **Keyboard-first.** Every action has a shortcut.
- **Private by default.** Everything is stored locally in SQLite. No accounts, no telemetry. Two network requests, both visible: an update check at launch, which you can turn off, and calendar sync once you connect a calendar. Updates are never installed without your approval.
- **Export.** SQLite backup, Markdown folder, CSV, or an `.ics` calendar of your scheduled pages, at any time.
- **Command line and MCP.** `pikos` reads and writes the same workspace file, and `pikos mcp` serves it to an AI agent over the Model Context Protocol. Local, no account, no listening socket.

## Command line and MCP server

`brew install pikos-app/tap/pikos-cli` puts `pikos` on your PATH. It opens the same workspace file the desktop app uses, so `pikos today`, `pikos add "Email Sam tomorrow 2pm #work"`, and `pikos search` work against your real notes.

`pikos mcp` speaks the [Model Context Protocol](https://modelcontextprotocol.io) over stdio, so an agent can search, read, create, and update your pages. It opens no network socket, so nothing reaches your notes except the assistant that started it. Deleting only moves a page to the trash, and the server never migrates your workspace on its own. Setup and the full reference: [`crates/pikos-cli/README.md`](crates/pikos-cli/README.md) and [pikos.app/cli](https://pikos.app/cli).

## Stack

| Layer           | Technology                                           |
| --------------- | ---------------------------------------------------- |
| Desktop shell   | [Tauri 2](https://v2.tauri.app) (Rust)               |
| Frontend        | React 19 + TypeScript (strict)                       |
| Editor          | [Tiptap](https://tiptap.dev) (ProseMirror)           |
| Database        | SQLite with FTS5                                     |
| UI              | [shadcn/ui](https://ui.shadcn.com) + Tailwind CSS v4 |
| Build           | Vite + Turborepo                                     |
| Package manager | pnpm                                                 |

## Repository structure

```
apps/
  desktop/      Tauri app (Rust backend + React frontend)
  ios/          iPhone app
  marketing/    pikos.app website (Astro + Tailwind)
  brand/        logos and brand assets
packages/       shared TypeScript: core logic, editor schema, UI components,
                and the builds the CLI and iOS app consume
crates/         shared Rust: SQLite data layer, domain logic, CLI, calendar
                sync, recurrence engine, replica sync, Swift bindings
```

## Development

Prerequisites: [Node.js](https://nodejs.org) (v24), [pnpm](https://pnpm.io) (v10), [Rust](https://rustup.rs), and the [Tauri 2 system dependencies](https://v2.tauri.app/start/prerequisites/) for your platform.

```bash
git clone https://github.com/pikos-app/pikos.git
cd pikos
pnpm install
pnpm dev:desktop
```

| Command                    | What it does                                                |
| -------------------------- | ----------------------------------------------------------- |
| `pnpm dev:desktop`         | Start the desktop app in dev mode, on its own dev workspace |
| `pnpm dev:desktop:prod-db` | Same, against your real workspace                           |
| `pnpm dev:marketing`       | Start the marketing site dev server                         |
| `pnpm verify`              | Run the checks a change has to pass                         |
| `pnpm test`                | Run unit tests                                              |
| `pnpm build`               | Build all packages                                          |

## Data

All data is stored in a local SQLite database. The schema is defined across migration files in [`crates/pikos-db/migrations/`](crates/pikos-db/migrations/). Every page is simultaneously a rich-text document, a trackable task, and a calendar event: one `pages` table with structured metadata columns alongside ProseMirror JSON content.

The database location follows your OS conventions:

- **macOS**: `~/Library/Application Support/app.pikos.desktop/`
- **Linux**: `~/.local/share/app.pikos.desktop/`

You can open the database with any SQLite client and query your own data directly.

## License

Pikos is source-available under the [Business Source License 1.1](LICENSE). You can read, audit, and build the code for personal use. Commercial redistribution is not permitted. The license converts to Apache 2.0 after four years.

See the [blog](https://pikos.app/blog) for more on the licensing philosophy.
