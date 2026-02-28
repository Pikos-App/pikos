# Feature: Metadata Header

## Status
Not started. Blocked by React migration + VaultContext.

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

## Title
- Inline-editable (`contenteditable` div or controlled input)
- Canonical title source: this field (not an H1 in the editor body)
- Changes call `updatePage(id, { title })`
- Auto-focused when a new page is created (`Cmd+N`)

## Status Toggle (GOO-33)
| Value | Icon | Color | Pages list |
|-------|------|-------|-----------|
| `not_started` | ○ empty circle | muted | normal |
| `in_progress` | ◑ half-filled | accent blue | bold title |
| `done` | ✓ checkmark | muted green | strikethrough + muted |

Click cycles through states. Sets `status` column + `completedAt` when → done.

## Priority Selector (GOO-35)
| Value | Label | Icon | Color |
|-------|-------|------|-------|
| 0 | None | — | muted |
| 1 | Urgent | !! | red |
| 2 | High | ! | orange |
| 3 | Medium | ·· | yellow |
| 4 | Low | · | blue/muted |

Icon-based selector, Linear-inspired. Sets `priority` column.

## Scheduled Date/Time Picker (GOO-34)
- Click → shadcn Popover
- Popover contains: mini calendar (month view) + time input
- Quick chips: "Today", "Tomorrow", "Monday", "Next week"
- Duration shortcuts: 15min, 30min, 1h, 2h
- Sets `scheduledStart` and `scheduledEnd` columns

## Tags
- Display tags as `Badge` components
- Click "+" to add a tag (inline input with autocomplete from existing tags)
- Click × on badge to remove
- Sets `tags` JSON array column

## Tasks
- [ ] Create `MetadataHeader` component in `apps/desktop/src/features/editor/components/MetadataHeader.tsx`
- [ ] Inline-editable title
- [ ] Animated expand/collapse
- [ ] Persist collapse state in localStorage
- [ ] `Cmd+Shift+M` keyboard shortcut via `useKeyboardShortcut`
- [ ] Status toggle (GOO-33)
- [ ] Priority selector (GOO-35)
- [ ] Date/time picker (GOO-34)
- [ ] Tags display + add/remove
- [ ] All changes call `updatePage()` from VaultContext
