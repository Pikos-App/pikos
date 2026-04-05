# Feature: Recurring Page Completion & Exceptions

## Summary

Recurring pages use a "head + clone-on-complete" model. The head page is the living series — it owns the recurrence rule, holds template content, and always represents the next upcoming occurrence. Completing the head snapshots it into a detached done page and advances the head's schedule to the next occurrence.

## Data Model

### Existing (no schema changes needed)

- `pages` — the head page (status, scheduled_start/end, content, etc.)
- `page_recurrence_rules` — one rule per recurring page (rrule, timezone, exdates)
- `page_schedules` — materialized overrides for individual occurrences (ruleId, originalDate, status)

### Key invariants

- **Head page ID is stable.** The same page ID represents the series for its entire lifetime. Backlinks, focus sessions, deep links, and "last opened" all reference the head.
- **Head's `scheduledStart`** always reflects the next upcoming occurrence (denormalized from the recurrence rule).
- **Head's `status`** stays `not_started` while the series is active. Setting the head to `done` without advancing means "end the series."
- **Completed clones** are normal pages with `status=done`, `scheduledStart` set to the completed occurrence date, and no recurrence rule. They are fully independent after creation.

## Completion Flow (head)

Triggered from: Today view checkbox, page list checkbox, page view checkbox, or the head's own calendar block checkbox.

1. **Clone the head** into a new page:
   - Copy: `title`, `content`, `tags`, `folder_id`, `priority`, `subtitle`
   - Set: `status = 'done'`, `scheduledStart` = head's current scheduledStart, `scheduledEnd` = head's current scheduledEnd, `completed_at = now()`
   - Do NOT copy: recurrence rule, sort_order
2. **Advance the head:**
   - Compute the next future occurrence from today (not from the current scheduledStart — skip missed occurrences)
   - Update head's `scheduledStart` to the next occurrence
   - Head's `status` stays `not_started`
3. **If no future occurrences exist** (e.g., rule has an UNTIL that's passed):
   - Mark head as `done` (series is finished)
   - Do not create a clone (the head itself is the final completion)

## Virtual Occurrence Interactions (calendar)

Virtual occurrences are rendered by `useRecurrenceExpansion` — they don't exist in the DB.

### Visual distinction
- Virtual blocks show the **recurring icon** (arrows) instead of a checkbox
- The head's own calendar block shows a normal **checkbox** (it's a real page)
- Virtual blocks use the same color/style as the head but are visually distinguishable

### Popover on virtual blocks
Read-only version of the standard PageBlock popover. Shows page metadata (title, folder, date, priority) but no inline editing. Interactive elements:

- **Open page** — opens the head page in the editor
- **Reschedule** — materializes a `page_schedule` override row with new time + `originalDate` + `ruleId`. Virtual replaced by the materialized override on calendar. No undo — modification is lightweight and visible.
- **Delete this occurrence** — adds date to `rruleExdates`, virtual disappears immediately. Shows undo toast (same pattern as page deletion). Undo removes the date from exdates.

### No completion on virtual blocks
Virtual occurrences cannot be independently completed. Completion only happens on the head. This avoids the "advance through intermediate" complexity.

## Exception Handling

### Skip (delete single occurrence)
- Add the occurrence date to `page_recurrence_rules.rruleExdates`
- The virtual expansion already filters exdates — the occurrence disappears

### Reschedule (modify single occurrence)
- Create a `page_schedule` row with:
  - `ruleId` = the recurrence rule ID
  - `originalDate` = the original rrule occurrence date
  - `scheduledStart/End` = the new time
  - `status = 'not_started'`
- Virtual expansion excludes dates with materialized overrides — the virtual disappears, the override renders instead
- The override shows as a normal calendar block (checkbox, no recurring icon)

### Modify content for a single occurrence
- Not supported in V1. Content lives on the head and applies to all occurrences.
- Per-occurrence notes happen naturally: write in the head before completing, clone captures them.

## Page View UI

When viewing a page that has a recurrence rule:

- Show recurrence cadence below the schedule chip (e.g., "Repeats every week on Monday")
- Show the next scheduled occurrence date (head's `scheduledStart`)
- Completing via checkbox triggers the clone-and-advance flow described above
- The date chip updates to show the new next occurrence after completion

## Today View

- The head page appears in Today when its `scheduledStart` is today or overdue
- After completion, the head advances — if the next occurrence is in the future, it drops out of Today
- Completed clones appear in the "Completed" section like any other done page

## Search

- Search returns the head (incomplete, sorts first) + any completed clones
- Multiple results with the same title is expected — each has a different date
- FTS indexes the head's content; completed clones get their own FTS entries on creation

## Deleting a Recurring Series

Deleting the head page (soft delete via `deleted_at`) stops the series:
- `listRecurrenceRules` already filters `deleted_at IS NULL` — no virtual occurrences rendered
- Completed clones are independent pages — NOT cascade-deleted. They remain as completion history.
- Backlinks to the head render as broken/grayed links (standard behavior for deleted pages). The head can be restored from trash, which restores the series and the backlink.

## Implementation Phases

### Phase 1: Core completion flow
- Rust: `complete_recurring_page` command (clone + advance logic)
- Frontend: Wire up checkbox for recurring pages to call the new command
- Update `decisions.md` completion model entry

### Phase 2: Page view UI
- Show recurrence cadence label on pages with rules
- Show next occurrence date
- Checkbox triggers complete_recurring_page

### Phase 3: Virtual occurrence popover
- Skip occurrence (add to exdates)
- Reschedule occurrence (materialize override)
- Open page (navigate to head)

### Phase 4: Calendar visual polish
- Virtual blocks: recurring icon, no checkbox
- Head block: normal checkbox
- Materialized override blocks: normal checkbox, no recurring icon
