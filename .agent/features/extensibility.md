# Feature: Extensibility — Plugin System & AI Agent

## Status
Not started. Deferred until the core app is stable (post-Phase 4). Architecture decisions made now
should not block implementation later — see "What to keep in mind today" below.

---

## Why extensibility

The default Pikos app should be dead simple — tasks, notes, calendar. No configuration required.
But some users will want more: custom views, integrations, automation, AI assistance.

The plugin system is how Pikos stays approachable by default while being infinitely deep for power
users. Features like the performance monitor (GOO-55), a local AI assistant, a Pomodoro timer, or
a kanban view don't belong in the core app — they're plugins.

This also solves the "should we build X?" question: if a feature is speculative or appeals to a
niche, make it a plugin rather than debating whether to ship it.

---

## Part 1: Plugin System

### Model

Plugins are **ES module bundles** loaded from `~/.pikos/plugins/<id>/index.js`. Each plugin
declares its permissions in a `plugin.json` manifest. The user approves permissions on install.

```json
{
  "id": "pomodoro",
  "name": "Pomodoro Timer",
  "version": "1.0.0",
  "description": "25-minute focus blocks, tracked against pages",
  "permissions": ["vault:read", "vault:write", "ui:panel", "ui:command"],
  "network": false
}
```

Permissions are explicit, minimal, and shown to the user before install. Network access is
**off by default** — a plugin cannot make HTTP requests unless `"network": true` is declared
and the user approves it. This is the core of the privacy story.

### Plugin API

Each plugin receives a `PluginContext` object — not `window.pikos`, not raw Tauri commands.
The context is the only way a plugin can interact with the app.

```ts
// packages/core/src/plugin/PluginContext.ts
export interface PluginContext {
  // Data access — scoped to permissions
  vault: {
    getPage(id: string): Promise<Page | null>
    createPage(data: NewPage): Promise<Page>
    updatePage(id: string, updates: PageUpdate): Promise<Page>
    deletePage(id: string): Promise<void>
    listPages(filter?: PageFilter): Promise<Page[]>
    searchPages(query: string): Promise<SearchResult[]>
    listFolders(): Promise<Folder[]>
  }

  // UI registration
  ui: {
    // Add a panel to the left sidebar (below folders list)
    registerPanel(opts: {
      id: string
      title: string
      icon: string
      component: React.ComponentType<{ ctx: PluginContext }>
    }): void

    // Add an item to the command palette (Cmd+K)
    registerCommand(opts: {
      id: string
      title: string
      subtitle?: string
      shortcut?: string
      run(): void | Promise<void>
    }): void

    // Add a Tiptap extension to the editor
    registerEditorExtension(extension: Extension): void

    // Add an item to the page right-click context menu
    registerPageContextItem(opts: {
      id: string
      label: string
      run(page: Page): void | Promise<void>
    }): void
  }

  // App events (read-only subscriptions)
  events: {
    on(event: 'page:created' | 'page:updated' | 'page:deleted' | 'page:opened' | 'vault:loaded',
       handler: (payload: unknown) => void): () => void  // returns unsubscribe fn
  }

  // Plugin-scoped settings storage (key/value, isolated per plugin)
  settings: {
    get<T>(key: string): Promise<T | null>
    set<T>(key: string, value: T): Promise<void>
  }

  // Plugin metadata
  manifest: PluginManifest
}
```

The `vault` sub-object is a direct pass-through to `StorageAdapter` — no new abstraction needed.
This means the plugin API is automatically consistent with the core app.

### Security model

| Concern | Approach |
|---|---|
| Data exfiltration | Network off by default; explicit permission + user approval to enable. All requests visible in network monitor (GOO-58). |
| FS access beyond vault | Tauri CSP + allowlist: plugins cannot access arbitrary file paths |
| Vault data leakage between plugins | Each plugin gets its own `PluginContext` instance; no shared state |
| Malicious plugins | v1: local plugins only (user installs manually); no auto-update, no marketplace trust yet |
| Tauri command injection | Plugins route through `PluginContext` only, never call `invoke()` directly |

### Distribution roadmap

| Phase | What's available |
|---|---|
| v1 | Local plugins: user places folder in `~/.pikos/plugins/`, app loads on restart |
| v2 | Official registry: curated, reviewed, signed. Install from Settings > Plugins. |
| v3 | Community registry with safety scanning (like VS Code Marketplace) |

v1 is dev-mode only — the plugin folder approach is perfect for building and testing plugins
(including internal ones like GOO-55 performance monitor) before any registry exists.

### Example plugins (what this unlocks)

- **Performance monitor** (GOO-55) — could live as a built-in plugin rather than core
- **Local AI assistant** (see Part 2) — built-in plugin
- **Kanban board** — register a panel with drag-to-reorder by status column
- **Pomodoro timer** — panel + commands, writes `durationMinutes` to completed pages
- **Habit tracker** — daily recurring pages in a designated folder
- **GitHub Issues sync** — requires `network: true`, pulls issues as pages
- **Template library** — `registerCommand` items that create pages from templates
- **Weekly review** — command that opens a generated summary page

### What to keep in mind today (architecture)

The plugin system doesn't need to be built now, but a few choices made in Phase 0–2 affect it:

1. **`packages/core` stays framework-agnostic** — the `StorageAdapter` interface is the plugin
   data API. Already true; just don't pollute `packages/core` with React deps.
2. **VaultContext events** — when implementing `VaultContext`, emit events via a lightweight
   `EventEmitter` (or just an array of listeners) on `createPage`, `updatePage`, etc. Plugins
   subscribe to these. Cost: ~10 lines in VaultContext. Payoff: plugins get reactive updates.
3. **UI registration points** — `App.tsx` should have clearly marked extension points
   (sidebar panels slot, command palette registry) that the plugin system later populates.
   Even if unused for now, the slots should be architecturally obvious.

---

## Part 2: AI Agent / Personal Assistant

### What it is

An opt-in AI assistant that has **structured, tool-based access** to your vault — not just reading
markdown text, but understanding and manipulating pages, tasks, folders, and calendar events as
typed data. The power comes from the structured data model: the agent knows a page's status,
priority, schedule, and tags, and can set them precisely.

Example interactions:
- *"What do I have scheduled today?"* → queries `list_pages` filtered by today's date range
- *"Mark the Smith project kickoff as done"* → `update_page` with `status: 'done'`
- *"Schedule 2 hours for the API refactor next Tuesday at 10am"* → `update_page` with `scheduledStart/End`
- *"What's overdue?"* → `list_pages` with `scheduledBefore: now, status: not 'done'`
- *"Create a task for each action item in this meeting note"* → reads current page, creates N pages
- *"Summarize what I worked on last week"* → `list_pages` with last week's date range + content read

### Architecture

```
┌─────────────────────────────────────────────────────┐
│  Agent Panel (UI)                                    │
│  ┌─────────────────────────────────────────────────┐│
│  │ Chat input / response thread                    ││
│  │ Tool call confirmations (write ops)             ││
│  └─────────────────────────────────────────────────┘│
└────────────────────┬────────────────────────────────┘
                     │
              AgentService (TS)
              packages/core/src/agent/AgentService.ts
                     │
          ┌──────────┴──────────┐
          │                     │
   ModelProvider          VaultToolSet
   (swappable)            (StorageAdapter wrapper)
          │
   ┌──────┴──────┐
   │             │
 Local         Cloud
 (Ollama)      (Anthropic/OpenAI — user's own API key)
```

### Model providers

**Local model (Ollama) — default, private**
- Runs as a sidecar process or connects to user's existing Ollama install
- `llama3`, `mistral`, or `qwen2.5` — good enough for task/calendar queries
- Zero data leaves device. Works offline.
- Lower capability: better for simple queries, weaker at complex reasoning over many pages

**Cloud model (user's API key) — opt-in**
- User provides their own Anthropic or OpenAI API key (stored in OS keychain, never in SQLite)
- Pikos sends only the relevant context (search results, current page) — never the full vault
- More capable for complex summarization, cross-page reasoning
- Explicit disclosure: "Using this feature sends selected note excerpts to [Anthropic/OpenAI]"

User chooses in Settings > Assistant. Local first, cloud opt-in.

### Tool definitions

The agent's tools are a thin wrapper over `StorageAdapter`. No new backend work required beyond
what Phase 0–3 already builds:

```ts
// packages/core/src/agent/tools.ts
export const vaultTools = [
  {
    name: "search_pages",
    description: "Full-text search across all pages in the vault",
    inputSchema: { query: z.string() },
    run: (adapter) => (input) => adapter.searchPages(input.query)
  },
  {
    name: "get_page",
    description: "Get the full content and metadata of a specific page by ID",
    inputSchema: { id: z.string() },
    run: (adapter) => (input) => adapter.getPage(input.id)
  },
  {
    name: "list_pages",
    description: "List pages with optional filters for folder, status, priority, scheduled dates",
    inputSchema: PageFilter,
    run: (adapter) => (input) => adapter.listPages(input)
  },
  {
    name: "create_page",
    description: "Create a new page or task",
    inputSchema: NewPageSchema,
    run: (adapter) => (input) => adapter.createPage(input),
    requiresConfirmation: true  // write op — show to user before executing
  },
  {
    name: "update_page",
    description: "Update a page's title, content, status, priority, or schedule",
    inputSchema: z.object({ id: z.string(), updates: PageUpdateSchema }),
    run: (adapter) => (input) => adapter.updatePage(input.id, input.updates),
    requiresConfirmation: true
  },
  {
    name: "get_context",
    description: "Get current app context: today's date, active page, today's schedule",
    inputSchema: z.object({}),
    run: (adapter, appContext) => () => ({
      today: new Date().toISOString(),
      activePage: appContext.activePage,
      todayPages: // list_pages filtered to today
    })
  }
]
```

`requiresConfirmation: true` on write operations means the UI shows the proposed action and asks
the user to approve before executing. Read ops run silently. This is configurable: "auto-approve
writes" mode for power users who trust the agent.

### Context management

The agent doesn't receive the full vault on every message — that would be slow and expensive.
Instead, it gets a lightweight "ambient context" + tool access to fetch more:

**Ambient context (always included in system prompt):**
- Today's date and day of week
- Current active page title + metadata (not full content)
- Count of pages due today / overdue
- Names of folders

**On demand (via tool calls):**
- Full page content (`get_page`)
- Filtered page lists (`list_pages`)
- Full-text search (`search_pages`)

This keeps the context window small for simple queries while allowing deep access for complex ones.

### UI

An agent panel toggled via `Cmd+Shift+A` (or Settings > Assistant when disabled). Lives as a
right-side panel, sibling to the calendar panel.

```
┌─────────────────────────────────────────────────────┐
│ ✦ Assistant                              [×] close  │
├─────────────────────────────────────────────────────┤
│                                                     │
│  You: What's overdue?                               │
│                                                     │
│  ✦ Searching for scheduled pages past due...        │
│                                                     │
│  You have 3 overdue tasks:                          │
│  • Write quarterly review (was Mar 1)               │
│  • Follow up with Sam (was Feb 28)                  │
│  • Review API docs (was Feb 25)                     │
│                                                     │
│  Want me to reschedule any of these?                │
│                                                     │
├─────────────────────────────────────────────────────┤
│ Ask anything about your notes and tasks...   [send] │
└─────────────────────────────────────────────────────┘
```

Tool calls that write data show a confirmation step inline:

```
│  ✦ I'll mark "Write quarterly review" as done.      │
│  [Confirm]  [Cancel]                                │
```

### Security model

| Concern | Approach |
|---|---|
| Data leaving device (cloud model) | Only context relevant to the query is sent. Never the full vault. Explicit disclosure before first use. |
| API key storage | OS keychain (`keyring` crate), never in SQLite or any file |
| Agent executing destructive ops | Write ops require explicit user confirmation by default |
| Prompt injection via note content | Sanitize page content before injecting into prompt. Don't trust note content as instructions. |
| Local model | All data stays on device. Ollama runs locally. |

### Relationship to plugin system

The AI agent is a **built-in plugin** — implemented using the same `PluginContext` API that
third-party plugins use. This has two benefits:
1. It validates the plugin API (if the agent can be built as a plugin, the API is expressive enough)
2. Third-party plugins can register **additional tools** for the agent — e.g., a GitHub plugin
   could add a `create_github_issue` tool that the agent can use

```ts
// A third-party plugin registering an agent tool
ctx.agent.registerTool({
  name: "create_github_issue",
  description: "Create a GitHub issue from the current page",
  inputSchema: z.object({ repo: z.string() }),
  run: async (input) => { /* GitHub API call */ },
  requiresConfirmation: true
})
```

---

## Backlog items generated

- **GOO-56** Plugin system foundation _(Deferred)_ — `PluginContext` API, local plugin loading,
  permission model, VaultContext event emitter. Implement after Phase 4 is stable.
- **GOO-57** AI agent / personal assistant _(Deferred)_ — `AgentService`, `vaultTools`, model
  provider abstraction (Ollama + cloud), agent panel UI, confirmation flow.
  Dependency: GOO-56 (plugin system) for the `ctx.agent.registerTool` extension point.
