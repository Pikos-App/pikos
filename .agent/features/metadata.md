# Feature: Metadata Header

## Status
Not started. Unblocked — React migration, WorkspaceContext, and Tiptap editor (GOO-10) are all shipped.
Next: GOO-109 (title/subtitle) ships first as the lightweight version, then GOO-32 adds the full collapsible metadata row.

## Goal
A collapsible header above the editor that surfaces all page metadata fields in a clean UI.
Bridges the gap between raw data and polished UX. No frontmatter — all fields are SQLite columns.

## Design
```
┌──────────────────────────────────────────────┐
│ ● My Page Title                      [↑ hide]│  ← collapsed
├──────────────────────────────────────────────┤
│ ○ Status  ↑ Priority  📅 Mar 3 · 3pm  #tag  │  ← expanded row 1
│ Parent: / Project Alpha                      │  ← expanded row 2
└──────────────────────────────────────────────┘
```

- Title always visible, inline-editable (click to edit)
- Collapsed: title + status badge + expand toggle
- Expanded: all metadata in a clean 1–2 row layout
- Expand/collapse: CSS `grid-template-rows: 0fr → 1fr` (no layout jump)
- Persist collapse state per-page in localStorage (keyed by page id)
- Rendered by `EditorPanel`, not the editor itself — keeps the editor clean

## Keyboard
- `Cmd+Shift+M` — toggle metadata panel
- `Tab` — move through fields when expanded
- `Esc` from any field — return focus to editor

## Auto-save overview
All fields save automatically. See `features/editor.md` → Auto-save for the full spec including
the `useAutosave` hook, flush triggers, save indicator, and error handling.

**Rule of thumb:** text fields (title, subtitle) debounce 500ms; discrete actions (status, priority,
tags, schedule) save immediately on the action.

## Title
- Inline-editable (`contenteditable` div or controlled input)
- Canonical title source: this field (not an H1 in the editor body)
- **Save**: `useAutosave` with 500ms debounce → `updatePage(id, { title })`
- **Flush**: on `window.blur`, page switch, app close
- Auto-focused when a new page is created (`Cmd+N`)

## Subtitle
- One-sentence summary below the title (single-line input, newlines blocked)
- Shown in `PageListItem` (line 2, muted, truncated) and `PageBlock` in calendar (below title)
- Optional — most pages won't have one
- Manual entry only in V1; AI summarization is a V2 feature (via AI assistant plugin)
- **Save**: `useAutosave` with 500ms debounce → `updatePage(id, { subtitle })`
- **Flush**: on `window.blur`, page switch, app close
- Included in FTS index alongside title and content

## Status Toggle (GOO-33)
| Value | Icon | Color | Pages list |
|-------|------|-------|-----------|
| `not_started` | ○ empty circle | muted | normal |
| `in_progress` | ◑ half-filled | accent blue | bold title |
| `done` | ✓ checkmark | muted green | strikethrough + muted |

Click cycles through states.
- **Save**: immediate → `updatePage(id, { status, completedAt })` on click
- Sets `completedAt` to `now()` when transitioning to `done`; clears it otherwise

## Priority Selector (GOO-35)
| Value | Label | Icon | Color |
|-------|-------|------|-------|
| 0 | None | — | muted |
| 1 | Urgent | !! | red |
| 2 | High | ! | orange |
| 3 | Medium | ·· | yellow |
| 4 | Low | · | blue/muted |

Icon-based selector, Linear-inspired.
- **Save**: immediate → `updatePage(id, { priority })` on selection

## Scheduled Date/Time Picker (GOO-34)
- Click → shadcn Popover
- Popover contains: mini calendar (month view) + time input
- Quick chips: "Today", "Tomorrow", "Monday", "Next week"
- Duration shortcuts: 15min, 30min, 1h, 2h
- **Save**: immediate → inserts a `page_schedules` row on picker confirm/close
- Removes all-day flag if a specific time is picked; sets `scheduled_all_day = true` if date-only
- "Remove" button in picker → deletes the `page_schedules` row

## Tags
- Display tags as `Badge` components
- Click "+" to add a tag (inline input with autocomplete from existing tags)
- Click × on badge to remove
- **Save (add)**: immediate → `updatePage(id, { tags })` on Enter / comma / blur in tag input
- **Save (remove)**: immediate → `updatePage(id, { tags })` on × click
- Sets `tags` JSON array column

## Tasks
- [ ] Create `MetadataHeader` component in `apps/desktop/src/features/editor/components/MetadataHeader.tsx`
- [ ] Inline-editable title
- [ ] Inline-editable subtitle (single-line, below title, muted style)
- [ ] Animated expand/collapse
- [ ] Persist collapse state in localStorage
- [ ] `Cmd+Shift+M` keyboard shortcut via `useKeyboardShortcut`
- [ ] Status toggle (GOO-33)
- [ ] Priority selector (GOO-35)
- [ ] Date/time picker (GOO-34)
- [ ] Tags display + add/remove
- [ ] All changes call `updatePage()` from WorkspaceContext
