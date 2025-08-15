# Personal Knowledge OS

A local-first desktop application that serves as a knowledge base with task management and calendar scheduling capabilities. Think Obsidian meets TickTick.

## Features

### Current (Basic UI)
- ✅ Three-panel layout (folders, pages, content)
- ✅ Folder navigation with color coding
- ✅ Page list with filtering (all, scheduled, unscheduled)
- ✅ Basic content editing
- ✅ Task completion toggling
- ✅ Responsive design with Tailwind CSS

### Planned
- 📅 Calendar view with time blocking
- 🔍 Full-text search across content
- 📁 File system integration (markdown files)
- 🏷️ Tag management and filtering
- ⌨️ Keyboard shortcuts and navigation
- 📱 Cross-platform support (desktop first)
- 🔄 Local-first with optional sync

## Tech Stack

- **Frontend**: SvelteKit + TypeScript
- **Desktop**: Tauri (Rust backend)
- **Styling**: Tailwind CSS
- **State Management**: Svelte stores
- **Storage**: Local filesystem + SQLite (planned)

## Development

```bash
# Install dependencies
pnpm install

# Start development server
pnpm dev

# Build for production
pnpm build

# Run Tauri app
pnpm tauri dev
```

## Project Structure

```
src/
├── components/          # UI components
│   ├── FolderSidebar.svelte
│   ├── PagesList.svelte
│   └── ContentPanel.svelte
├── stores/             # State management
│   └── appStore.ts
├── routes/             # SvelteKit routes
└── app.css            # Global styles
```

## Design Philosophy

- **Local-first**: All data stored locally, no cloud dependency
- **Simple & Fast**: Minimal UI, keyboard-driven navigation
- **Flexible**: Pages can be notes, tasks, or scheduled items
- **Transparent**: Files stored as markdown, visible to user
- **Integrated**: Knowledge management and task scheduling in one app
