# Feature: Calendar

## Status
In progress. Storage layer (GOO-29) complete. Commands (GOO-76) next.
Depends on: GOO-29 (SQLite), GOO-76 (page_schedules commands).

## Philosophy
Don't use an off-the-shelf calendar library (FullCalendar, etc.) — too opinionated.
Build a lightweight custom renderer using `date-fns`.
"Calendar should be BUTTERY." — product goal.

## Product Role
The calendar is a first-class scheduling surface — not a view-only calendar. It's where you
time-block your pages, see what's on your plate, and mark things done. Completion can happen
directly on calendar blocks without opening the editor.

---

## Scheduling Requirements

Six scheduling modes are fully supported by the current schema. All are expressed via
`page_schedules` rows (except infinite recurring, which uses `pages.rrule`).

### 1. All-day (single day)
"Schedule for March 4th."
```
scheduled_all_day = 1
scheduled_start   = '2026-03-04'      -- date-only string
scheduled_end     = NULL              -- NULL = single day
```

### 2. Specific time, no explicit end
"Schedule for March 4th at 4pm."
```
scheduled_all_day = 0
scheduled_start   = '2026-03-04T16:00:00.000Z'
scheduled_end     = NULL              -- calendar renders as 1h block by convention
```

### 3. Timed block with explicit duration
"Schedule March 4th 4pm–5pm."
```
scheduled_all_day = 0
scheduled_start   = '2026-03-04T16:00:00.000Z'
scheduled_end     = '2026-03-04T17:00:00.000Z'
```

### 4. Multiple independent occurrences
"Schedule March 4th AND March 5th" — or "March 4th at 4pm AND March 4th at 5pm."
Two (or more) rows in `page_schedules` for the same `page_id`. Each row is independent.
Insert, update, and delete rows individually. The page itself is never duplicated.

### 5. Infinite recurring (rrule)
"Every Monday at 5pm."
```
pages.rrule      = 'FREQ=WEEKLY;BYDAY=MO;BYHOUR=17;BYMINUTE=0'
pages.timezone   = 'America/New_York'   -- IANA; used by rrule.js for DST-correct expansion
```
- Stored on the `pages` table, NOT in `page_schedules`
- Calendar expands virtual blocks at render time via `rrule.js` — no rows written by default
- A page with `rrule` set is a *recurring template*. Specific occurrences can be overridden
  via `page_schedules` rows with `original_rrule_date` set (see Exception Handling below).

#### Exception Handling
Two mechanisms alongside `pages.rrule`:

**Skip an occurrence** — add the date to `pages.rrule_exdates` (JSON array of ISO date strings).
Calendar renderer filters out virtual blocks whose date appears in this array.
```
pages.rrule_exdates = '["2026-03-09","2026-03-16"]'
```

**Override an occurrence** — materialise the virtual block as a real `page_schedules` row
with `original_rrule_date` set to the date being replaced. The row's times can differ.
Calendar skips the virtual block for that date and shows the real row instead.
```sql
INSERT INTO page_schedules
  (id, page_id, scheduled_start, scheduled_end, scheduled_all_day, original_rrule_date, ...)
VALUES
  (newUUID, 'page-abc', '2026-03-23T18:00:00Z', '2026-03-23T19:00:00Z', 0, '2026-03-23', ...);
```

**Per-occurrence completion** — `page_schedules.status` tracks each materialised occurrence
independently (`'not_started'` | `'done'` | `'skipped'`). Virtual blocks that have not been
materialised reflect the parent page's `status`.

### 6. Multi-day span
"March 4th through March 6th."
```
scheduled_all_day = 1
scheduled_start   = '2026-03-04'
scheduled_end     = '2026-03-06'      -- inclusive end date
```
Calendar renders this as a banner spanning those days (like Google Calendar all-day events).

---

## String format by mode

| `scheduled_all_day` | `scheduled_start` format | `scheduled_end` format |
|---------------------|--------------------------|------------------------|
| `1` (all-day)       | `'YYYY-MM-DD'`           | `'YYYY-MM-DD'` or NULL |
| `0` (timed)         | ISO 8601 with time       | ISO 8601 with time or NULL |

When `scheduled_end = NULL`:
- All-day → single day (same as start)
- Timed → 1-hour default block height in the calendar renderer

**Timezone**: V1 stores local time as ISO 8601. No explicit timezone column. This is
acceptable for single-user, single-machine use. Timezone normalization is a sync-era concern.

---

## V1 Scope (GOO-21) — Day view first, weekly after
- Day view (today, navigate prev/next day)
- Time grid: 6am–11pm, 1-hour rows, 15-minute snap
- All-day section at top of day column (for `scheduled_all_day = 1` blocks)
- Multi-day banners shown in all-day section for each day they span
- Scheduled pages appear as blocks sized by duration (absolutely positioned by time %)
- Click block → `setActivePage()` in VaultContext → opens page in editor (right panel stays calendar)
- Hover block → quick-action bar appears: `[✓ Done]` `[✕ Remove]` `[⋮]`
  - `✓ Done` → `updatePage(id, { status: 'done', completedAt: now })` → block fades to muted/strikethrough
  - `✕ Remove` → `deletePageSchedule(scheduleId)` — removes the calendar row, not the page
- Resize bottom edge of block → `updatePageSchedule(scheduleId, { scheduledEnd })` (15min snap)
- Navigate days: `[` / `]` keyboard shortcuts, "Today" button / `t` shortcut (`allowInInputs: false`)
- `NowIndicator`: current time red line, auto-scrolls into view on mount
- Toggle calendar/editor view: `Cmd+Shift+C` or toolbar button
- Recurring pages rendered as virtual blocks (rrule expansion) — not editable in v1, click opens page

## V2 (later)
- Weekly view (7 columns)
- Exception handling for recurring pages (skip / move single occurrence)
- Filter calendar by tag or folder

---

## Component Tree
```
CalendarView                   ← replaces editor panel when calendar mode active
├── CalendarHeader             ← date display, prev/next/today buttons
├── AllDaySection              ← all-day + multi-day banner blocks
├── TimeGutter                 ← hour labels (6am, 7am, ...)
├── DayColumn
│   ├── HourCells              ← drop targets, 15min increments
│   ├── PageBlock[]            ← absolutely positioned by (start/duration)%
│   │   └── ResizeHandle       ← drag bottom edge to update scheduledEnd
│   └── NowIndicator           ← current time red line
```

---

## Drag to Schedule (GOO-39)
- Library: `@dnd-kit/core`
- Drag handle appears on `PageListItem` hover (left edge)
- Drop on `HourCell` → calls `createPageSchedule(pageId, scheduledStart, scheduledEnd)`
  (does NOT call `updatePage` — schedule rows are the source of truth for calendar blocks)
- 15-minute snap on drop
- After creating a schedule row, the denorm `pages.scheduled_start/end` is updated to the
  earliest future row for that page (handled by the Rust `create_page_schedule` command)

## Animation
- `framer-motion` for spring physics on `PageBlock` drag/drop and snap
- `AnimatePresence` for block mount/unmount when pages are scheduled/unscheduled
- `layout` prop on `PageBlock` for smooth position transitions when blocks reorder

---

## External Calendar Sync (GOO-22)
CalDAV protocol — works with Fastmail, Google, Apple, Proton, etc. See full spec in BACKLOG GOO-22.

- External events render as `ExternalEventBlock` — visually distinct from `PageBlock`
  (muted, account color, lock icon, no drag handle)
- User actions: **dismiss** (local hide, never written back) or **"Convert to page"**
  (creates Pikos page from event data)
- Connect directly to the calendar source — never through a re-exporting intermediary
  like TickTick (causes duplicates)
- No write-back to external calendars, ever

---

## Data Model

### `page_schedules` table (full schema)
```sql
CREATE TABLE page_schedules (
  id                   TEXT PRIMARY KEY,   -- UUID
  page_id              TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  scheduled_start      TEXT NOT NULL,      -- 'YYYY-MM-DD' or ISO 8601 datetime
  scheduled_end        TEXT,               -- same format as start; NULL = single day / 1h default
  scheduled_all_day    INTEGER NOT NULL DEFAULT 0,  -- 1 = all-day/multi-day; 0 = timed block
  status               TEXT NOT NULL DEFAULT 'not_started', -- 'not_started'|'done'|'skipped'
  original_rrule_date  TEXT,              -- if set, this row overrides a specific virtual rrule occurrence
  created_at           TEXT NOT NULL
);
```

### Recurring fields on `pages`
- `pages.rrule` — iCal RRULE string; NULL if not a recurring template
- `pages.rrule_exdates` — JSON array of ISO date strings excluded from rrule expansion (default `'[]'`)
- `pages.timezone` — IANA timezone string; NULL = system default; used by `rrule.js` for DST-correct expansion

### Denorm on `pages`
`pages.scheduled_start` / `pages.scheduled_end` = the **earliest future** `page_schedules`
row for that page. Used by list views for "what's scheduled next" without joining.
- Updated by the Rust `create_page_schedule` and `delete_page_schedule` commands after
  every mutation (not via a DB trigger — kept on the application side for clarity)
- When no future schedule rows exist, both columns are set to NULL

### rrule vs page_schedules
| | `page_schedules` | `pages.rrule` |
|---|---|---|
| Use case | Explicit one-off or multiple specific dates | Infinite recurring template |
| Storage | DB rows, one per occurrence | Single iCal RRULE string on the page |
| Calendar rendering | Read rows directly | Expanded virtually via `rrule.js` |
| Editable in v1 | Yes — add/remove rows individually | Set or clear the whole rule |
| Mix on same page? | No — a page uses one or the other | No |

### Calendar queries
```sql
-- Blocks for a given day (timed + all-day)
SELECT ps.*, p.title, p.status, p.priority
FROM page_schedules ps
JOIN pages p ON p.id = ps.page_id
WHERE date(ps.scheduled_start) <= '2026-03-04'
  AND (ps.scheduled_end IS NULL OR date(ps.scheduled_end) >= '2026-03-04')
ORDER BY ps.scheduled_start ASC;

-- Today smart view (list panel)
SELECT DISTINCT p.*
FROM page_schedules ps
JOIN pages p ON p.id = ps.page_id
WHERE date(ps.scheduled_start) <= date('now')
  AND p.status != 'done';
```
