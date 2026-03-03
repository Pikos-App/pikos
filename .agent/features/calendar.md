# Feature: Calendar

## Status
Not started. Depends on: storage (GOO-29), React migration (GOO-26).

## Philosophy
Don't use an off-the-shelf calendar library (FullCalendar, etc.) — too opinionated.
Build a lightweight custom renderer using `date-fns`.
"Calendar should be BUTTERY." — product goal.

## Product Role
The calendar is a first-class scheduling surface — not a view-only calendar. It's where you
time-block your pages, see what's on your plate, and mark things done. Completion can happen
directly on calendar blocks without opening the editor.

## V1 Scope (GOO-21) — Day view first, weekly after
- Day view (today, navigate prev/next day)
- Time grid: 6am–11pm, 1-hour rows, 15-minute snap
- Scheduled pages appear as blocks sized by duration (absolutely positioned by time %)
- Click block → `setActivePage()` in VaultContext → opens page in editor (right panel stays calendar)
- Hover block → quick-action bar appears: `[✓ Done]` `[✕ Remove]` `[⋮]`
  - `✓ Done` → `updatePage(id, { status: 'done' })` → block fades to muted/strikethrough
  - `✕ Remove` → deletes the `page_schedules` row (not the page) → block disappears
- Resize bottom edge of block → updates `scheduled_end` on `page_schedules` row (15min snap)
- Navigate days: `[` / `]` keyboard shortcuts, "Today" button / `t` shortcut (`allowInInputs: false`)
- `NowIndicator`: current time red line, auto-scrolls into view on mount
- Toggle calendar/editor view: `Cmd+Shift+C` or toolbar button

## Component Tree
```
CalendarView                   ← replaces editor panel when calendar mode active
├── CalendarHeader             ← date display, prev/next/today buttons
├── TimeGutter                 ← hour labels (6am, 7am, ...)
├── DayColumn
│   ├── HourCells              ← drop targets, 15min increments
│   ├── PageBlock[]            ← absolutely positioned by (start/duration)%
│   │   └── ResizeHandle       ← drag bottom edge to update scheduledEnd
│   └── NowIndicator           ← current time red line
```

## Drag to Schedule (GOO-39)
- Library: `@dnd-kit/core`
- Drag handle appears on `PageListItem` hover (left edge)
- Drop on `HourCell` → `updatePage({ scheduledStart, scheduledEnd })`
- 15-minute snap on drop

## Animation
- `framer-motion` for spring physics on `PageBlock` drag/drop and snap
- `AnimatePresence` for block mount/unmount when pages are scheduled/unscheduled
- `layout` prop on `PageBlock` for smooth position transitions when blocks reorder

## External Calendar Sync (GOO-22)
CalDAV protocol — works with Fastmail, Google, Apple, Proton, etc. See full spec in BACKLOG GOO-22.

- External events render as `ExternalEventBlock` — visually distinct from `PageBlock` (muted, account color, lock icon, no drag handle)
- User actions: **dismiss** (local hide, never written back) or **"Convert to page"** (creates Pikos page from event)
- Connect directly to the calendar source — never through a re-exporting intermediary like TickTick (causes duplicates)
- No write-back to external calendars, ever

## V2 (later)
- Weekly view (7 columns)
- Recurring pages
- Filter calendar by tag or folder
- All-day section at top

## Data Model

### Multiple Occurrences — `page_schedules` table
One page can appear as multiple calendar blocks (e.g. "work on this task Tuesday AND Thursday").
Each row in `page_schedules` = one calendar block. Drag-to-schedule inserts a new row; it never
overwrites. To remove a block, delete the row (not the page).

- `page_schedules(id, page_id, scheduled_start, scheduled_end, created_at)`
- Calendar queries `page_schedules JOIN pages` — not `pages.scheduled_start` — for block rendering

### Denorm on pages
`pages.scheduled_start` / `pages.scheduled_end` remain as a denorm = the next upcoming
`page_schedules` row for that page. Used by list views for "what's scheduled next" without
a join. Kept in sync by a trigger or on the TS side after schedule mutations.

### rrule distinction
`pages.rrule` is for *infinite recurring templates* (e.g. weekly standup — generates virtual
blocks via rrule.js at render time, no rows stored). Distinct from `page_schedules`, which is
for explicit one-off or finite multi-occurrence scheduling.

- Pages without any `page_schedules` rows are unscheduled (shown in sidebar list only)
- If `scheduled_end` not set on a row, default block height = 1 hour
