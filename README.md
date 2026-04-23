<p align="center">
  <img src="apps/brand/svg/pikos-dark.svg" alt="Pikos" width="128" height="128">
</p>

# Pikos

Notes, tasks, and calendar — in one app, on your device.

Pikos is a local-first desktop app that combines a rich text editor, task management, and a calendar into a single tool. No accounts, no cloud, no subscriptions. Your data is a SQLite file on your machine.

**[Website](https://pikos.app)** &middot; **[Download](https://pikos.app/download)** &middot; **[Blog](https://pikos.app/blog)**

## Features

- **Rich text editor** — Headings, bold, italic, checklists, code blocks, blockquotes. Slash commands, format toolbar, Markdown paste support.
- **Task management** — Status tracking, four-level priority, tags, smart views (Today, Inbox), drag-and-drop reordering.
- **Built-in calendar** — Week view alongside the editor. Drag pages to schedule them. Click a time slot to create a page.
- **Full-text search** — FTS5-powered search across all page content. Ranked results with previews.
- **Quick capture** — Natural language input: "Call dentist tomorrow high priority #health" creates a page with title, date, priority, and tag set automatically.
- **Keyboard-first** — Every action has a shortcut. Navigate, create, schedule, and search without reaching for the mouse.
- **Private by default** — Everything stored locally in SQLite. No accounts, no telemetry. The only network request is a version check at launch — updates are never installed without your approval.
- **Export** — SQLite backup or JSON export at any time. Your data is portable.

## Stack

| Layer | Technology |
|-------|------------|
| Desktop shell | [Tauri 2](https://v2.tauri.app) (Rust) |
| Frontend | React 19 + TypeScript (strict) |
| Editor | [Tiptap](https://tiptap.dev) (ProseMirror) |
| Database | SQLite with FTS5 |
| UI | [shadcn/ui](https://ui.shadcn.com) + Tailwind CSS v4 |
| Build | Vite + Turborepo |
| Package manager | pnpm |

## Repository structure

```
pikos/
  apps/
    desktop/        — Tauri app (Rust backend + React frontend)
    marketing/      — pikos.app website (Astro + Tailwind)
  packages/
    core/           — Shared TypeScript library (types, utils, storage interface)
```

## Development

Prerequisites: [Node.js](https://nodejs.org) (v20+), [pnpm](https://pnpm.io) (v10+), [Rust](https://rustup.rs), and the [Tauri 2 system dependencies](https://v2.tauri.app/start/prerequisites/) for your platform.

```bash
git clone https://github.com/pikos-app/pikos.git
cd pikos
pnpm install
pnpm dev:desktop
```

### Commands

| Command | What it does |
|---------|-------------|
| `pnpm dev:desktop` | Start the Tauri desktop app in dev mode |
| `pnpm dev:marketing` | Start the marketing site dev server |
| `pnpm verify` | Run typecheck, lint, prettier, dependency cruiser, and tests |
| `pnpm test` | Run unit tests (Vitest) |
| `pnpm build` | Build all packages |

## Data

All data is stored in a local SQLite database. The schema is defined across migration files in [`apps/desktop/src-tauri/migrations/`](apps/desktop/src-tauri/migrations/). Every page is simultaneously a rich-text document, a trackable task, and a calendar event — one `pages` table with structured metadata columns alongside ProseMirror JSON content.

The database location follows your OS conventions:
- **macOS**: `~/Library/Application Support/app.pikos.desktop/`
- **Linux**: `~/.local/share/app.pikos.desktop/`

You can open the database with any SQLite client and query your own data directly.

## License

Pikos is source-available under the [Business Source License 1.1](LICENSE). You can read, audit, and build the code for personal use. Commercial redistribution is not permitted. The license converts to Apache 2.0 after four years.

See the [blog](https://pikos.app/blog) for more on the licensing philosophy.
