# Feature: Sidebar Navigation

## Status
Not started. Depends on: VaultContext (GOO-30), React migration (GOO-26).

## Product Vision
Pikos replaces both Obsidian (rich content, folders, backlinks, search) and TickTick (task lists,
smart views, scheduling, recurring tasks), with the calendar as a first-class scheduling surface —
not an add-on. Every page is simultaneously a note and a task.

## Three-Panel Layout (GOO-14)
```
[Left 180px] | [Page List 280px] | [Editor OR Calendar — flex]
```
- All panels resizable via drag handles
- Persist widths via Tauri store
- **Right panel** toggles between Editor (default) and Calendar (`Cmd+Shift+C`)
  — the left and middle panels stay visible in both modes
  — you can see and drag from the page list while the calendar is open

## Sidebar Collapse (GOO-80)

Two states only — no partial collapse. Either all three panels are visible, or only the right panel
(editor or calendar) is visible. There is no way to collapse just one of the two left panels.

### States
```
Open (default):
┌──────────┬──────────────┬──────────────────────────────┐
│ Today  5 │ ▾ Work       │ [◀] Write API docs      [···] │
│ Inbox  3 │   ○ Page 1   │                               │
│ Work  58 │   ○ Page 2   │   Editor content              │
│ Dog    5 │              │                               │

Collapsed:
┌──────────────────────────────────────────────────────────┐
│ [▶] Write API docs                                  [···] │
│                                                           │
│   Editor content (full width)                             │
```

### Toggle Button — `SidebarToggle`
Pinned to the **top-left corner of the right panel header**, always visible in both states.
- Icon: `PanelLeftClose` when open, `PanelLeftOpen` when collapsed — lucide-react
- Tooltip: `"Hide sidebar  ⌘\\"` / `"Show sidebar  ⌘\\"`
- Icon animates (subtle rotate) as the panels slide

### Animation
Both panels animate together via `framer-motion`:
```tsx
<motion.div
  animate={{ width: sidebarCollapsed ? 0 : panelWidth, opacity: sidebarCollapsed ? 0 : 1 }}
  transition={{ type: 'spring', stiffness: 350, damping: 35 }}
  style={{ overflow: 'hidden', flexShrink: 0 }}
/>
```
- Spring physics — snaps closed/open with a natural feel, not a linear slide
- `overflow: 'hidden'` prevents content clipping mid-transition
- Resize handles live inside the `motion.div` so they vanish with the panels
- Right panel fills via CSS flex — no explicit width animation needed on it

### State
`UIContext.sidebarCollapsed: boolean` — persisted in `localStorage` (`pikos:sidebarCollapsed`).
Survives app restarts.

---

## Navigation Keyboard Shortcuts

All shortcuts registered via `useKeyboard` with `allowInInputs: false` unless noted.

| Shortcut | Action |
|---|---|
| `Cmd+\` | Toggle sidebar (both left panels open ↔ collapsed) |
| `Cmd+Shift+C` | Toggle right panel: Editor ↔ Calendar |
| `J` | Select next page in the current list (wraps) |
| `K` | Select previous page in the current list (wraps) |
| `Enter` | Open the currently selected page in the editor |
| `Escape` | Return focus from editor → page list |
| `Cmd+P` | Open page search / quick-open palette (Phase 3, GOO-17) |
| `Cmd+K` | Open command palette — actions, new page, settings (Phase 3, GOO-17) |
| `[` / `]` | Calendar: previous / next day (only active when calendar is open) |
| `T` | Calendar: jump to today (only active when calendar is open) |

**`J`/`K` behaviour:**
- Global shortcuts — work from anywhere (editor, calendar, sidebar)
- Move the highlighted row in the page list, but do not auto-open the page
- `Enter` (or clicking) opens it — avoids accidental navigation while working
- When sidebar is collapsed, `J`/`K`/`Enter` still work — they just auto-expand the
  sidebar before opening so the user can see what they navigated to

## Vault Selection (GOO-15)
- First-launch: welcome screen (full window, no panels) with three options:
  - "Create New Vault" → folder picker → creates `pikos.db` in that folder → open app
  - "Open Existing Vault" → folder picker → opens an existing Pikos `pikos.db` → open app
  - "Import from Obsidian" → triggers GOO-41 import flow → open app with content
- Vault list stored in `@tauri-apps/plugin-store` (see multi-vault design in `features/storage.md`)

## Smart Views

Pinned at the top of the left panel. Not real folders — virtual filtered views. Cannot be deleted,
renamed, or reordered. Distinct icons to signal they're special.

```
┌─────────────────────────┐
│ ☀ Today           (5)  │  ← scheduled today + overdue
│ ⬇ Inbox           (3)  │  ← unfiled pages
├─────────────────────────┤
│ Lists                   │
│ ● Work             58   │
│ ● Personal         15   │
└─────────────────────────┘
```

### Today
Query: pages with any `page_schedules` row where `date(scheduled_start) <= date('now')`
and `pages.status != 'done'`. Grouped in the page list by:

```
▸ Overdue  3            ← past scheduled_start, not done (collapsed by default)
▾ Today, Mon Mar 2  5
   ○ [9:00] Write API docs       ← time-blocked
   ○ [14:00] Review PR #42
   ○ Team standup  ↻             ← all-day or recurring badge
   ○ Dog grooming                ← scheduled today, no time
```

- Badge = total count of today + overdue (urgent signal)
- Overdue section collapsed by default but badge count includes it
- Completing a page from Today view checks it off and removes it from the list

### Inbox
Pages where `folder_id IS NULL`. The default landing zone for new pages.
- Badge shows count of unfiled pages; hidden when inbox is empty
- Selectable like any folder: click → pages panel shows `WHERE folder_id IS NULL`
- "Capture fast, organize later" — deliberately frictionless

**UIContext tracks `activeViewId: 'today' | 'inbox' | string (folderId)`**

## Folder CRUD (GOO-37)

v1: **flat list only** — no nesting. `parent_id` stays in the schema for future use but is never
populated. Folders are "buckets" — a flat, ordered list of named lists.

- **Create**: right-click sidebar background or "+" button in panel header →
  inline rename field auto-focused on creation
- **Rename**: double-click folder name → inline edit → Enter to confirm, Esc to cancel
- **Delete**: right-click → confirm dialog (warn if folder has pages — offer to move to inbox first)
- **Color**: color picker in right-click context menu → updates the folder's indicator dot
- **Reorder**: drag-and-drop via `@dnd-kit/core`, calls `reorderFolders(orderedIds[])`

## New Page UX (GOO-60)

`Cmd+N` from anywhere → opens the Quick Add Modal. This is the single, consistent entry point
for new page creation regardless of where in the app you are.

The modal defaults its folder chip to `UIContext.activeFolderId`. Folder priority:
1. Active folder in sidebar → chip pre-set to that folder
2. Inbox selected → chip shows "Inbox"
3. No folder context (e.g. triggered from calendar view) → `Settings.defaultFolderId`

See GOO-60 in BACKLOG.md for full modal spec and NL syntax.

## Pages List

Shows pages in the selected folder (or inbox). Controlled by `UIContext.activeFolderId`.

- **GOO-16** Completion: completed pages → strikethrough + muted → collapsed into
  "Completed" accordion at bottom. UI toggle button.
- **GOO-16** Drag-to-reorder: `@dnd-kit/core`, drag handle on hover, calls `reorderPages(folderId, orderedIds[])`
- **GOO-38** Filters bar in panel header:
  | Filter | Values |
  |--------|--------|
  | Status | All / Active / Done / In Progress |
  | Scheduled | All / Scheduled / Unscheduled / Today / This Week |
  | Priority | All / Urgent / High / Any |
  | Tag | Multi-select |
  Filters persist per session.

## First-Run Onboarding (GOO-42)
- New vault: empty state — inbox shown, friendly prompt + keyboard shortcut hints
- Obsidian import: progress bar → lands in app with content in inbox (unfiled) or folders
  (if import preserved directory structure as folders)
