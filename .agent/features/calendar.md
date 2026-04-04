# Feature: Calendar — Future Work & Key Decisions

## Key Decisions (non-obvious)

### Custom Renderer
No off-the-shelf calendar library. Custom build with `date-fns` for full control. "Calendar should be BUTTERY."

### Scheduling Data Model
- `page_schedules` table = explicit occurrences (one row per block)
- `page_recurrence_rules` = RRULE templates (expanded virtually at render, not pre-generated)
- `pages.scheduled_start/end` = denorms (next upcoming `page_schedules` row), updated by Rust commands

### Six Scheduling Modes
All-day, specific time (no end), timed block (start+end), multiple occurrences, infinite recurring (rrule), multi-day span. All expressed via `page_schedules` rows except rrule which lives on `pages`.

### Exception Handling for Recurring
- Skip: add date to `pages.rrule_exdates` JSON array
- Override: materialize virtual block as real `page_schedules` row with `original_rrule_date`
- Per-occurrence completion: `page_schedules.status` tracks each materialized occurrence independently

## Current State
Week view shipped with all-day section, hourly grid, drag-to-create, resize, inline editing.

## Unbuilt Features

- **Day view**: Single-day focused view (originally V1 scope, week view shipped first)
- **Recurring event UI**: rrule expansion renders virtual blocks but no creation/editing UI yet
- **Exception handling UI**: Skip/override single occurrences of recurring pages
- **Calendar filtering**: Filter by tag or folder
- **CalDAV sync (GOO-22)**: Read-only external calendar events via CalDAV. External events visually distinct (muted, lock icon). Actions: dismiss (local), convert to page. No write-back.
- **Timezone handling (GOO-64)**: All times stored as UTC, display in local tz via `date-fns-tz`. Deferred until sync era.
