# Pikos — Active Backlog

Working queue from Phase 2 through Public Launch. Ordered by the sequence things need to ship.
For post-launch specs — grep `BACKLOG.md` by GOO number.

Status: `[ ]` pending · `[~]` in progress · Delete task when done.

---

## Phase 2A — Core Editor & Metadata

- [~] **GOO-119** Quick Add: preview-on-type, strip-on-submit _(High — prerequisite for GOO-60)_

### Summary

Refactor the Quick Add parse architecture to fix three interconnected bugs caused by parse-and-strip-on-space:

1. **Date+time context loss**: "Run monday 2pm" → space after "monday" strips it, then "2pm" parses as time-only (today/tomorrow) instead of "monday at 2pm". Chrono never sees the combined expression.
2. **Duration state lost on submit**: "for 30m" is stripped from input but there's no `durationValue` chip state. Final parse of the clean title finds no duration → silently lost.
3. **Debounce space insertion**: 800ms debounce always appends trailing space to input (`cleanTitle + " "`). If cursor is mid-token (e.g. `~` before typing folder name), the space breaks the token.

### Architecture change

Replace the current parse-and-strip-on-space flow with **preview-on-type, strip-on-submit**:

**Current (broken):**
- Space press → `runParseAndStrip()` → parse input, update chips, strip tokens from input, reposition cursor
- Debounce (800ms) → same `runParseAndStrip()`
- Submit → final parse of (already-stripped) input

**New:**
- Input change (debounced ~200ms) → `runPreview()` → parse full input, update chip previews. **Never modify input text.**
- Submit (Enter / click Add) → parse full input → use parsed values merged with chip overrides → create page

### What to change

**QuickAddDialog.tsx:**

1. **Delete `runParseAndStrip()`** — replace with `runPreview(raw: string)` that only calls `parseInput(raw)` and updates chip state (dateValue, priorityValue, folderValue). No `setInputValue`, no cursor manipulation.

2. **Replace the space-press handler** (lines 183–188):
   - Remove the `requestAnimationFrame(() => runParseAndStrip(...))` call on space press.
   - The debounce effect already covers preview — space press needs no special handling.

3. **Replace the debounce effect** (lines 160–172):
   - Change from 800ms to ~200ms for responsiveness (chips should feel instant).
   - Call `runPreview(inputValue)` instead of `runParseAndStrip(inputValue)`.
   - Still reset chips to defaults when input is empty.

4. **Update `handleSubmit()`** (lines 193–239):
   - Parse `inputValue.trim()` (the full, unstripped input).
   - Use `parsed.title` as the page title (parser already strips tokens from the title).
   - Use `parsed.scheduledStart ?? dateValue` (unchanged — chip override still works).
   - Use `parsed.durationMinutes` directly (no need for chip state — it's in the full input).
   - Use `parsed.priority` with fallback to `priorityValue` (unchanged).
   - Use `parsed.tags` directly (unchanged).
   - Use `parsed.folderQuery` with fallback to `folderValue` (unchanged).

5. **Remove the `handleKeyDown` space handler entirely** — only keep the Enter handler for submit.

### Why this fixes all three bugs

- **Date+time**: Chrono always sees the full input ("monday 2pm"), so it parses them as a combined expression.
- **Duration**: Parsed from full input on submit; no intermediate state needed.
- **Space insertion**: Input text is never modified by the parser. No trailing space, no cursor repositioning.

### UX tradeoff

Tokens stay visible in the input (e.g. user sees "Run monday 2pm #work" instead of "Run " after stripping). But chips clearly show interpreted values. This is more predictable and matches how TickTick, Todoist, and Linear handle NLP input.

### Testing checklist

- Type "Run monday 2pm" → date chip shows Monday at 2pm (not today at 2pm).
- Type "Run monday 2pm for 30m" → date chip shows Monday at 2pm, submit creates page with durationMinutes=30 and scheduledEnd.
- Type "meeting ~" then pause → no space inserted after `~`. Continue typing "Projects" → folder chip updates to Projects.
- Type "#work !high tomorrow" → all three chips update as you type. Input still shows full text.
- Manually change date chip via picker → type a new date token → NLP date overrides picker (last-write-wins preserved).
- Submit with Enter (no trailing space) → page created correctly with all metadata.
- Empty input → chips reset to defaults (folder=current, date=none, priority=none).

---

- [ ] **GOO-120** NLP: add `!0-4` numeric priority syntax _(Low)_

### Summary

Extend the NLP parser to support numeric priority shortcuts `!0` through `!4`.

### Mapping

| Syntax | Priority | Equivalent |
|--------|----------|------------|
| `!0` | none (clear) | — |
| `!1` | urgent | `!urgent` |
| `!2` | high | `!high` |
| `!3` | medium | `!medium` |
| `!4` | low | `!low` |

### What to change

**`packages/core/src/nlp/parser.ts`:**

1. Add a second priority regex pass after the existing named priority regex (line 97–102):
   ```typescript
   // Numeric priority: !0 (none) through !4 (low)
   const NUMERIC_PRIORITY_MAP: Record<string, PagePriority | null> = {
     "0": null, // clear priority
     "1": "urgent",
     "2": "high",
     "3": "medium",
     "4": "low",
   };
   text = text.replace(/!([0-4])\b/g, (_, n: string) => {
     const mapped = NUMERIC_PRIORITY_MAP[n];
     if (mapped !== undefined) {
       priority = mapped ?? undefined;
     }
     return " ";
   });
   ```
   Note: `!0` should clear priority (set to `undefined`), so typing `!0` explicitly means "no priority".

2. **QuickAddDialog.tsx**: Handle `priority === undefined` from NLP when `!0` is used — `NLP_PRIORITY_MAP` lookup should fall through to `priorityValue = 0` (the "no priority" state).

### Testing

- `task !1` → priority: "urgent"
- `task !4` → priority: "low"
- `task !0` → priority: undefined (none)
- `task !1 !3` → priority: "medium" (last wins)
- `task !5` → not matched, stays in title
- `task !urgent` → still works (unchanged)

---

- [ ] **GOO-121** Evaluate tags normalization: tags + page_tags tables _(Medium — decision before GOO-60)_

### Summary

Currently tags are stored as a JSON array on `pages.tags TEXT`. Before building tag chips (GOO-60), decide whether to normalize to `tags(id, name)` + `page_tags(page_id, tag_id)` tables.

### Why consider normalizing

- **Autocomplete**: A `tags` table enables `SELECT name FROM tags WHERE name LIKE ?` for instant tag suggestions in Quick Add.
- **Global rename/merge**: Renaming a tag is one UPDATE instead of parsing/updating every page's JSON array.
- **Tag-based views**: `SELECT p.* FROM pages p JOIN page_tags pt ON p.id = pt.page_id WHERE pt.tag_id = ?` is cleaner and indexable vs JSON array scanning.
- **Deduplication**: Normalized table enforces uniqueness; JSON arrays require app-level dedup.
- **FTS**: Tag names can be included in FTS5 content via a simple JOIN.

### Why keep JSON arrays

- **Simpler**: No migration, no join tables, no extra queries on page create/update.
- **Good enough for v1**: With <1000 pages, JSON array scanning is fast enough.
- **Matches current code**: `updatePage({ tags: [...] })` already works.

### Decision criteria

- If we want tag autocomplete in Quick Add (likely yes for GOO-60 tag chips or shortly after) → normalize.
- If we want tag-based smart views or filters (likely yes for Phase 3) → normalize.
- If we just need to display parsed tags and save them → JSON is fine for now.

### Recommendation

Normalize now (before GOO-60). The migration is small (one `CREATE TABLE` + `CREATE TABLE` + backfill script), and it unblocks autocomplete which makes tag chips much more useful. Deferring means a harder migration later when pages have inconsistent tag data.

### If normalizing, migration plan

1. Add `tags(id TEXT PRIMARY KEY, name TEXT UNIQUE NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')))` table.
2. Add `page_tags(page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE, tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE, PRIMARY KEY (page_id, tag_id))` table.
3. Backfill: parse existing `pages.tags` JSON arrays → insert into `tags` + `page_tags`.
4. Keep `pages.tags` column as denormalized cache (or drop it — depends on query patterns).
5. Add Rust commands: `get_tags`, `create_tag`, `add_tag_to_page`, `remove_tag_from_page`, `search_tags(query)`.
6. Update `StorageAdapter` + `WorkspaceContext` to use normalized tables.

### Action required

Make a decision and document it in `.agent/decisions.md` before starting GOO-60.

---

- [ ] GOO-60 Phase 2a: Tag Chips in Quick Add

## Summary

Add visual tag chips to the Quick Add modal's metadata row. Tags are already being parsed by the NLP parser (`#tag` syntax) and saved on submit via `updatePage`, but they have no visual representation in the chip row. This task adds tag chips so users can see, remove, and manually add tags before submitting.

---

## Current state

- NLP parser recognizes `#tag` tokens and returns them in `parsed.tags: string[]`.
- On submit, tags are applied via `updatePage(page.id, { tags: parsed.tags })`.
- The chip row currently shows: DateChip · PriorityChip · FolderChip · [Add].
- Tags parsed from input are captured but invisible to the user.

---

## What to build

### Tag chips in the metadata row

Add tag chips between the FolderChip and the Add button:
Need to answer - what happens if there are many tags? How do you remove tags?

```
📅 Today  ·  🚩  ·  📁 Inbox  ·  #meeting  #work          [Add]
```

Each tag is a small pill/chip showing the tag name with a `#` prefix. Tags appear as they're parsed (on space press or 800ms debounce, same as other fields).

### Chip layout

- Tags sit after the FolderChip separator.
- Each tag chip is a small pill: muted background, tag text, and a small × button to remove.
- If there are no tags, nothing is shown (no empty state placeholder for tags — the row just ends at the folder chip).
- Tags should wrap if they overflow, but practically the modal is 600px wide and users won't add many tags in a quick-add flow, so a single flex row with `flex-wrap` is fine.

### Tag chip interactions

- **Parsed from input:** `#meeting` is typed → on space/debounce, tag chip appears, `#meeting` is stripped from input.
- **Remove a tag:** click the × on a tag chip → tag is removed from the tag state array. The stripped text is NOT re-inserted into the input.
- **Manual add:** For Phase 2a, there is no manual tag picker/popover. Tags can only be added via NLP input (`#tagname`). A tag picker popover is a future enhancement.
- **Duplicate handling:** If the user types `#work` and `#work` is already in the tag list, don't add it again. Deduplicate silently.

### Tag state

Add a `tagsValue` state array alongside the existing chip states:

```typescript
const [tagsValue, setTagsValue] = useState<string[]>([]);
```

Reset to `[]` in `openDialog()`.

### Parse integration

In `runParseAndStrip()` and the debounce effect, when `parsed.tags` has entries:

```typescript
if (parsed.tags && parsed.tags.length > 0) {
  setTagsValue(prev => {
    const combined = [...prev, ...parsed.tags];
    return [...new Set(combined)]; // deduplicate
  });
}
```

Note: tags **accumulate** across multiple parse passes (unlike date/priority/folder which overwrite). Typing `#meeting` then later `#work` should result in both tags being present. This is different from the other chip fields.

### Submit integration

In `handleSubmit`, use `tagsValue` (merged with any final-pass parsed tags) instead of only `parsed.tags`:

```typescript
const finalTags = [...new Set([...tagsValue, ...(parsed?.tags ?? [])])];
// ...
if (finalTags.length > 0) patch.tags = finalTags;
```

---

## Tag chip component

Build a small inline component (can live in the same file or extracted):

```typescript
function TagChip({ tag, onRemove }: { tag: string; onRemove: () => void }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-md bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
      #{tag}
      <button
        onClick={onRemove}
        aria-label={`Remove tag ${tag}`}
        className="ml-0.5 text-muted-foreground/60 hover:text-foreground transition-colors"
      >
        ×
      </button>
    </span>
  );
}
```

Style to match the existing chip row aesthetic — keep it subtle and small so it doesn't dominate the row.

---

## Updated chip row JSX

```tsx
<div className="flex items-center gap-2 border-t border-border/40 px-4 py-2.5 flex-wrap">
  <DateTimePicker value={dateValue} onChange={setDateValue} />
  <BylineSeparator />
  <PriorityDropdown priority={priorityValue} onSelect={setPriorityValue} variant="byline" />
  <BylineSeparator />
  <FolderChip folders={folders} value={folderValue} onChange={setFolderValue} />

  {tagsValue.length > 0 && (
    <>
      <BylineSeparator />
      {tagsValue.map(tag => (
        <TagChip
          key={tag}
          tag={tag}
          onRemove={() => setTagsValue(prev => prev.filter(t => t !== tag))}
        />
      ))}
    </>
  )}

  <button
    onClick={() => void handleSubmit()}
    className="ml-auto ..."
  >
    Add
  </button>
</div>
```

---

## Testing checklist

- Type `run #meeting ` → tag chip "meeting" appears, input shows "run ".
- Type `#work ` after → both "meeting" and "work" chips visible.
- Type `#meeting ` again → no duplicate, still just one "meeting" chip.
- Click × on "work" chip → "work" removed, "meeting" remains.
- Submit → page created with `tags: ["meeting"]`.
- 800ms debounce: type `run #meeting` and pause → tag chip appears (debounce preview + strip).
- Enter without space: type `run #meeting` and hit Enter → tag is parsed in final pass and saved.
- Reopen modal → tag state is empty (reset on open).

---

- [] GOO-60 Phase 2b: Recurring & Batch Page Confirmation

## Summary

When the NLP parser returns a recurring or finite-batch result, show a confirmation step before creating pages. Currently the Quick Add submit flow only handles `type: 'single'`. This task adds support for `type: 'recurring'` and `type: 'finite'` results with an intermediate confirmation dialog.

Note to self - when doing recurring scheduling with NLP, what should we show on the schedule button? The date picker doesn't account for recurring events yet. This is a big ol topic with a lot of UI/UX concerns. So maybe better to hold off on recurring until I get further along in the calenar.

---

## Current state

In `handleSubmit` and `runParseAndStrip`, the parsed result is extracted with a fallback that collapses everything to single:

```typescript
const parsed =
  result.type === "single"
    ? result.input
    : result.type === "finite"
      ? result.inputs[0]  // ← only takes the first, ignores the rest
      : result.input;
```

This needs to handle all three types properly.

---

## Parse result types

Check the actual return type of `parseInput` in the codebase. Based on the existing code, it returns a discriminated union roughly like:

```typescript
type ParseResult =
  | { type: "single"; input: ParsedInput }
  | { type: "finite"; inputs: ParsedInput[]; count: number }
  | { type: "recurring"; input: ParsedInput; rrule: string }
```

Verify the exact shape — the `rrule` field name and any additional metadata on the recurring type may differ.

---

## Confirmation rules

| Result type | Condition | Behavior |
|---|---|---|
| `single` | always | Create immediately, no confirmation (unchanged) |
| `finite` | `count < 3` | Create immediately, no confirmation |
| `finite` | `count >= 3` | Show confirmation dialog |
| `recurring` | always | Show confirmation dialog |

---

## Confirmation dialog

When confirmation is required, show a secondary dialog (or replace the Quick Add content) with:

### For finite batch (`count >= 3`):

```
┌──────────────────────────────────────────────────────────────┐
│  Create multiple pages?                                      │
│                                                              │
│  This will create 5 pages:                                   │
│                                                              │
│  · "Morning run" — Mon Mar 16                                │
│  · "Morning run" — Tue Mar 17                                │
│  · "Morning run" — Wed Mar 18                                │
│  · "Morning run" — Thu Mar 19                                │
│  · "Morning run" — Fri Mar 20                                │
│                                                              │
│                              [ Cancel ]  [ Create 5 pages ]  │
└──────────────────────────────────────────────────────────────┘
```

- Show the list of pages that will be created with their titles and dates.
- If the list is long (>10), show the first 5 and last 2 with "... and N more" in between.
- "Cancel" returns to the Quick Add input (don't close the modal, don't lose input state).
- "Create N pages" creates all of them.

### For recurring:

```
┌──────────────────────────────────────────────────────────────┐
│  Create recurring page?                                      │
│                                                              │
│  "Morning run"                                               │
│  Every weekday at 7:00 AM                                    │
│  Starting Mon Mar 16                                         │
│                                                              │
│                              [ Cancel ]  [ Create ]          │
└──────────────────────────────────────────────────────────────┘
```

- Display the RRULE in human-readable form. Use `rrule.js`'s `toText()` method if available, or write a simple formatter for common patterns (daily, weekly, weekdays, monthly).
- Show the start date.
- "Cancel" returns to the Quick Add input.
- "Create" creates the recurring page.

### Dialog implementation

Use a shadcn `AlertDialog` (or similar confirmation pattern) that overlays on top of the Quick Add dialog. The Quick Add stays open underneath — if the user cancels, they're right back where they were.

---

## Updated submit flow

```typescript
async function handleSubmit() {
  const finalValue = inputValue.trim();
  if (!finalValue) { /* shake, return */ }

  const result = parseInput(finalValue);

  // Check if confirmation is needed
  if (result.type === "recurring") {
    setConfirmation({ type: "recurring", result });
    return; // Don't create yet — wait for confirmation
  }

  if (result.type === "finite" && result.count >= 3) {
    setConfirmation({ type: "finite", result });
    return;
  }

  // Single or finite with count < 3 — create immediately
  await createFromResult(result);
}
```

### Confirmation state

```typescript
const [confirmation, setConfirmation] = useState<ConfirmationState | null>(null);

type ConfirmationState =
  | { type: "recurring"; result: RecurringParseResult }
  | { type: "finite"; result: FiniteParseResult };
```

When confirmation is dismissed: `setConfirmation(null)` — returns to Quick Add input.
When confirmed: call `createFromResult(confirmation.result)` then close everything.

---

## Page creation for each type

Extract a shared `createFromResult` function:

```typescript
async function createFromResult(result: ParseResult) {
  if (result.type === "single" || (result.type === "finite" && result.count < 3)) {
    const inputs = result.type === "single" ? [result.input] : result.inputs;
    for (const input of inputs) {
      await createSinglePage(input);
    }
    // Navigate to the first created page
  }

  if (result.type === "finite" && result.count >= 3) {
    for (const input of result.inputs) {
      await createSinglePage(input);
    }
    // Navigate to the first created page
  }

  if (result.type === "recurring") {
    // Create a single page with recurrence rule attached.
    // Check how PageRecurrenceRule is created in the codebase —
    // there may be an adapter method like createRecurrenceRule().
    // The page gets one PageRecurrenceRule row; the calendar expands
    // virtual occurrences via rrule.js at render time.
    await createRecurringPage(result.input, result.rrule);
  }

  setConfirmation(null);
  setOpen(false);
  setActivePage(firstCreatedPage.id);
}
```

### `createSinglePage` helper

Encapsulates the existing create → updatePage → scheduleOnce flow:

```typescript
async function createSinglePage(parsed: ParsedInput): Promise<Page> {
  const resolvedFolderId = /* folder resolution logic, same as current */;
  const page = await createPage({ title: parsed.title, folderId: resolvedFolderId });

  const patch: PageUpdate = {};
  if (priorityValue !== 0) patch.priority = priorityValue;
  if (parsed.tags.length > 0) patch.tags = [...new Set([...tagsValue, ...parsed.tags])];
  if (parsed.durationMinutes) patch.durationMinutes = parsed.durationMinutes;
  if (Object.keys(patch).length > 0) updatePage(page.id, patch);

  if (parsed.scheduledStart) {
    await scheduleOnce(page.id, parsed.scheduledStart, parsed.scheduledEnd);
  }

  return page;
}
```

### `createRecurringPage` helper

Check the codebase for how `PageRecurrenceRule` rows are created. There's likely an adapter method. The recurring page is a single page with a recurrence rule — the calendar expands virtual occurrences. If no adapter method exists yet, this may need to be added to the `WorkspaceContext` (flag it and ask rather than implementing a new adapter method blindly).

---

## Chip preview for recurring/finite

During the debounce preview and space-parse, if the result is `recurring` or `finite`:

- DateChip should show the **first** scheduled date (same as current behavior).
- Consider showing a small indicator that this is recurring/batch — e.g., a repeat icon (🔁) next to the date chip, or the date chip text could say "Every weekday" instead of a single date. Keep it simple — this is a nice-to-have, not a blocker.

---

## Testing checklist

- Type `run every weekday at 7am` → Enter → recurring confirmation dialog appears with RRULE summary.
- Cancel on confirmation → returns to Quick Add, input preserved.
- Confirm → recurring page created, modal closes, editor opens page.
- Type `run mon tue wed thu fri` (or whatever syntax produces finite with 5 entries) → Enter → batch confirmation shows 5 pages listed.
- Cancel → returns to Quick Add.
- Confirm → 5 pages created, editor opens the first one.
- Type `run mon tue` (finite, count=2, below threshold) → Enter → creates immediately, no confirmation.
- Type `run tomorrow` (single) → Enter → creates immediately, no confirmation (unchanged).
- Verify chip state (priority, tags, folder) is correctly applied to ALL pages in a batch create.

### Editor Enhancements

- [ ] **GOO-108** Tab key behavior in editor _(High)_
  Tab/Shift+Tab intercepted — no longer moves browser focus. Lists: indent/outdent ✓. Task items: indent/outdent ✓. Code blocks: insert/remove 2 spaces ✓. **Remaining:** Tab in normal paragraphs should insert/remove indentation (insertText with spaces not working in paragraph nodes — needs investigation).

- [ ] **GOO-114** Bubble format toolbar _(Medium)_ — **replaces removed persistent FormatToolbar**
  Selection-triggered floating toolbar. Appears anchored above the selection when text is selected in the editor. Buttons: Bold, Italic, Underline, Strikethrough, Code, Link (triggers LinkPopover), H1/H2/H3, bullet list, ordered list. Hides on click-outside or selection collapse. Use Tiptap's `BubbleMenu` component (`@tiptap/extension-bubble-menu` — already part of `@tiptap/starter-kit` peer deps). Position: above selection, centered, with a subtle drop-shadow and border. `FormatToolbar.tsx` contains all the button logic — reuse it inside `BubbleMenu`.

- [ ] **GOO-113** Editor accessibility _(High)_
  The editor needs WCAG 2.1 AA compliance per project standards. Currently missing: `role="textbox"` and `aria-label` on the editor container, `aria-live` region for save state announcements, visible focus indicator on the editor container, keyboard-accessible task list checkboxes, placeholder text announced to screen readers (currently CSS-only). Should be done alongside or right after GOO-106 (keyboard scope).
  **Note (from GOO-111):** Add `tabIndex={-1}` to the root `<div>` in `PageListItem.tsx` so that after Escape blurs the editor, the active page list item is properly focusable and receives visual focus. Currently the div is not natively focusable so `el.focus()` silently no-ops.

- [ ] **GOO-105** Editor drag handle _(Medium)_
- NOTE: we can deprioritize this for post launch.
  Hover left of any block to show a grip icon for drag-reorder. Custom ProseMirror NodeView plugin (the official `@tiptap/extension-drag-handle` is paid). Grip appears on hover with subtle fade-in. Drag creates a drop indicator line between blocks. Works with all block types (paragraphs, headings, lists, code blocks). Component: `apps/desktop/src/features/editor/components/DragHandle.tsx`. Before you get started on this one - are you intending to build this functionality from scratch since the dep is paid? How complex would this task be? Worth building in its current task priority?

---

## Phase 2B — Appearance & UX Polish

- [ ] **GOO-102** Completed items in folder/inbox views — design decision _(Medium)_
  Today view has a "Completed" accordion (GOO-101 ✓). Need to decide how completed items behave in folder and inbox views. Current: shown inline with strikethrough. Options under consideration:
  - Per-folder opt-in accordion (task-oriented folders get accordion, knowledge-base folders stay inline)
  - Global "Hide completed" toggle in sort menu
  - Automatic: folders with >N completed items get the accordion
  Key constraint: must stay simple and serve both task-manager and knowledge-base users without forcing a "task vs note" type distinction (TickTick's approach feels bolted-on). Every page is both. The UX should emerge from folder-level behavior, not page-level categorization.

- [ ] **GOO-99** Enhanced folder delete modal _(Medium)_ — **requires GOO-37 ✓**
  When deleting a folder that contains pages, replace the current fixed "move to Inbox" confirmation with two explicit choices:
  - **Move pages** (default) — folder selector dropdown pre-filled with "Inbox"; user can pick any other existing folder. On confirm: moves all pages in the deleted folder to the chosen destination (`updatePage({ folderId })` for each), then deletes the folder.
  - **Archive pages** — moves all pages to a hidden `archived` status (`status = 'archived'`) rather than deleting them. Pages disappear from all normal views but are recoverable via a future Archive view (GOO-TBD). On confirm: bulk-updates `status = 'archived'` for all pages in folder, then deletes the folder.

  Modal structure (shadcn `AlertDialog` + `Select` + `RadioGroup` or two `Button` variants):
  ```
  Delete "Project Alpha"?
  ○ Move pages to: [Inbox ▾]
  ○ Archive pages  (recoverable)
  [Cancel]  [Confirm]
  ```
  `FolderDeleteDialog` component in `apps/desktop/src/features/folders/components/`. `WorkspaceContext` may need a `bulkUpdatePages` or `archiveFolder` helper if individual `updatePage` calls are too chatty.

---

## 📅 Calendar — Pulled Forward

_Core product promise: notes + tasks + calendar. Must ship before friends beta._

- [ ] **GOO-21** Custom day/weekly calendar view _(High — friends beta blocker)_
  **v1: day view only.** Custom renderer with `date-fns`, no off-the-shelf calendar library.
  ```
  CalendarView
  ├── CalendarHeader (prev/next/today, [ / ] shortcuts)
  ├── TimeGutter (hour labels: 6am–11pm)
  ├── DayColumn
  │   ├── HourCells (drop targets, 15min increments)
  │   ├── PageBlocks (absolute position by time %)
  │   └── NowIndicator (current time red line, auto-scrolls on mount)
  ```
  Block click → `setActivePage()`. Resize bottom edge → update `scheduledEnd`. Toggle calendar/editor: `Cmd+Shift+C`. Jump to today: `t`.

- [ ] **GOO-39** Drag page → calendar to schedule _(High — friends beta blocker)_ — **requires GOO-21**
  `@dnd-kit/core`. Drag handle on `PageListItem` hover. Drop → `createPageSchedule({ scheduledStart, scheduledEnd })`. 15min snap.

---

## 🔍 Search & Commands — Minimum Quality Bar

_Without these the app feels half-finished to any organic user. Ship before public launch._

- [ ] **GOO-17** Command palette _(High — public launch blocker)_
  `Cmd+P` → fuzzy page title search. `Cmd+P` twice (chord) → content search mode. `Cmd+K` → actions (new page, switch workspace, settings). Recent pages section.
  Title search: client-side fuzzy via `fuse.js` against `pages[]` in WorkspaceContext (immediate, no DB round-trip). Content search: FTS5 via `search_pages` Tauri command (debounced). See `features/search.md`. It seems like this could use some more thought though — maybe we want server-side search, then we can return the data that's needed to navigate to the folder/page? This should be insanely fast regardless of how many pages/folders there are. Content search should also be ripping fast and top tier — highlight matching words/partial.

- [ ] **GOO-18** FTS5 content search _(High — public launch blocker)_
  FTS5 virtual table on `pages.content` + `pages.title` + `pages.tags`. Tauri command `search_pages(query)`. Updates on save. Highlighted excerpt snippets via FTS5 `snippet()`.

- [ ] **GOO-62** Undo/redo _(High — public launch blocker)_
  App-level command history for metadata mutations and CRUD — separate from Tiptap's own undo. `CommandHistory` singleton in `packages/core/src/history/CommandHistory.ts`.

  ```ts
  export interface Command {
    execute(): Promise<void>; // re-do only
    undo(): Promise<void>;
    label: string; // e.g. "Deleted 'Design review'"
  }
  export class CommandHistory {
    static shared: CommandHistory;
    push(cmd: Command): void; // call AFTER mutation; clears redo stack
    undo(): Promise<void>;    // Cmd+Z
    redo(): Promise<void>;    // Cmd+Shift+Z
    canUndo: boolean;
    canRedo: boolean;
    readonly undoLabel: string | null;
    readonly redoLabel: string | null;
  }
  ```

  Mutations that push a Command: create/delete/rename page, move page to folder, change status/priority/scheduled date, create/delete/rename folder.
  **Bulk undo**: Quick Add Modal creating N pages wraps all creates in one Command.
  **UI**: `Cmd+Z` / `Cmd+Shift+Z`. Toast: "Deleted 'Design review' · Undo". History limit: 50 entries (ring buffer).

---

## 🚀 Friends Beta Gate

_Must ship before sharing with anyone outside the team. External blocker: Apple Developer account ($99/yr)._

- [ ] **GOO-51** App branding _(Medium — friends beta blocker)_
  Icon, wordmark, color palette. Needed before any public presence. Tauri uses `apps/desktop/src-tauri/icons/` — multiple sizes required (32×32 to 512×512 + `.icns` for macOS).

- [ ] **GOO-52** Cross-platform builds + signing + GitHub Releases pipeline _(High — friends beta blocker)_
  `release.yml` triggered on `git tag v*`. Matrix: macOS (notarized via Apple Developer Program, `tauri-apps/tauri-action`), Windows (SmartScreen warning OK for Phase 2 beta), Linux (AppImage + deb, no signing needed).
  **One-time setup:** Apple Developer account → Developer ID cert → notarization credentials as GitHub secrets. `tauri-apps/tauri-action` automates sign + notarize on every tagged release. Budget ~2–3 hrs for first-time setup.

- [ ] **GOO-50** Auto-updater _(Medium — friends beta blocker)_
  `tauri-plugin-updater`. Check on launch → non-blocking banner ("Version X.X available — restart to update") → download + install + relaunch. Update server: GitHub Releases. Wire in before any external release.

---

## 🌐 Public Launch Gate (Phase 3)

_Required before the marketing site goes live and the download button appears._

- [ ] **GOO-53** Marketing site Phase 3 _(Medium — public launch blocker)_
  Phase 2.5 ✓ (landing page + email capture form live at pikos.app). Remaining for Phase 3:
  `/open` (open metrics), `/download` (release links), `/changelog`. See `features/marketing-site.md`.

- [ ] **GOO-116** Email capture backend integration _(High — public launch blocker)_
  The email form on the landing page is UI-only. Wire it to an email service so captured addresses are stored and can be emailed on launch.
  - Pick provider: Resend Audiences, Loops, or ConvertKit (all have free tiers; Loops is nicest for simple launch lists)
  - Add a serverless handler or use the provider's form endpoint directly (no server needed if using a hosted form endpoint)
  - On submit: POST to provider API → return success/error to UI → show confirmation state ("You're on the list!")
  - Double-opt-in not required for a launch waitlist
  - Store API key as env var in hosting platform (not in repo)

- [ ] **GOO-117** Marketing site analytics _(Medium — public launch blocker)_
  Lightweight, privacy-first page view tracking. No cookies, no fingerprinting — consistent with the product promise.
  - Recommended: Plausible (self-hosted or $9/mo cloud) or Fathom. Both are GDPR-compliant out of the box.
  - Alternative: roll a minimal hit counter using a Cloudflare Worker + KV (free tier, zero third-party) — fits the local-first brand story.
  - Add the script tag to the Astro layout so all pages are tracked automatically.
  - Verify no PII is collected and document the provider choice in `features/marketing-site.md`.

- [ ] **GOO-118** About page on marketing site _(Low — public launch blocker)_
  Short `/about` page: who built it and why, the local-first philosophy, contact/feedback link.
  - One page, no photos required — words carry it.
  - Link from footer next to Privacy.

- [ ] **GOO-54** Privacy policy on marketing site _(Low — public launch blocker)_
  Plain language, one page at `/privacy`. Cover: what stays on device (everything), what leaves only with opt-in (email address you typed in), what is never collected (note content), how to export data. Link from footer.

---

## 🔧 Developer Tooling

- [ ] **GOO-95** Dev: seed command — reset UI preferences _(Low)_
  Script or Tauri dev command to wipe `localStorage` and plugin-store settings keys back to defaults. Useful when testing first-run flows or settings panels. Can be a `pnpm dev:reset-ui` script that opens the app with a `?resetUI=1` query param cleared on startup, or a hidden `Cmd+Shift+Option+R` chord in dev builds only.

- [ ] **GOO-96** Dev: seed command — populate workspace _(Low)_
  Script that inserts a realistic dataset (folders, pages with varied status/priority/tags/schedules) into the active SQLite workspace. Goal: fill the UI for screenshot/demo/dev without manual entry. Invoke via `pnpm dev:seed`. Should be idempotent (no-op if seed marker page exists). ~20 pages across 4 folders + a few page_schedules rows.

---

_For post-launch V1, power features, and long-term roadmap — grep `BACKLOG.md` by GOO number._


To Document:
- Marketing Site
  - help content - create new folders, pages, quick add dialog and NLP, keyboard shortcuts
- General
  - git ignore build dir
  - the app should not auto correct anything (capitalize, fix spelling, etc)
- Editor
  - bubble menu for editor (removed toolbar since it was looking dated)
  - refine style of flashing cursor
  - when searching in a file, show highlighted word / partial word, also show occurrence in scroll bar (like arc / vscode)
  - word count / character count / links / backlinks / etc
  - right clicking to show context menu in editor
  - spell checker / squiggly lines
  - tab and shift+tab are not working in editor - need opus
  - when editing title, it should sync real time (local state, then debounce to db)
  - slash dropdown moves menu item to where mouse was, doesn't stay at top
  - bubble menu should be one tab index with left and right arrow movement
  - editor is still recommending to capitalize things
  - if there's a `/` in the content, the slash menu opens immediately upon opening editor
  - highlighting text
- Settings
  - disable bubble menu above text on highlight
  - disable slash commands
  - doing both would be simply markdown editor
  - Configurable metadata fields on the page, scheduled date, start date, end date, location, etc
  - sync with reminders 
- Questions
  - How does sharing work w/ icloud sync?
  - Can I have the code be open without showing my commit history? Why would I want this? Don't want to fully show how its made... or that I'm comparing it to other products directly?
  - Pikos name, meaning, copyright, etc. Is it a good name for a notes/tasks/calendar app? So far looks good. Got good domain (pikos.app), no copyrights in software.
- Calendar
  - when on the ticktick calendar, opening a task shows a small modal, can't search content, and when I switch to a different app (like my browser, the modal closes) (although this doesn't seem consistent, sometimes it stays open).
  - Page editor should be first class, not a small modal that is pretty inconvenient for content management.
- List View
  - Compact view for page list - don't show subtitle (more UI efficient)
  - Add sorting for... additional categories?
  - Navigate items with up and down keyboard, enter to open editor
  - Should i auto focus editor on enter key press? What about the checkbox on the UI - reachable? Too focused on keyboard navigation? Probably.
- Reflections
  - Editor functionality (indent, outdent, link popover, link behavior) is tough for Claude - lots of rate limi consumed to progress a little bit at a time.
  - Upgrade to claude max?
- Performance
  - How do I handle querying and pagination? Does the app need all data at all times? List views, completed states, calendar view, searching, etc. TickTick does 30 completed w/ view more - not sure about huge directories with hundreds of incomplete. 
- Observability
  - I'd like to track how many downloads have occurred through the site. And how many downloads have occurred through the app store. No tracking should be invasive or go against the privacy policy (tbd).
- Marketing site
  - Optimize marketing site for AI surfacing / recommendations - AEO (answer engine optimization). AI can pull the right meaning from your site.
  - balance phrasing and terminology - don't want to risk legal troubles with claims / encouraging things.
  - comparison page for similar products? 
- For Later
  - Further down the road - habit tracking, maybe a habits folder where you can set habits and their schedule through the normal UI - maybe using rrule. Then provide basic visuals on completion rates. Low priority.
  - Add password protection / biometric access? How would that work with no recovery code?
  - Under "Today" could do a "Priority" list, which shows items in priority order. Maybe not valuable enough for the prime real estate. Could conditionally render it if any items have priority.
  - page location? Like a Google Calendar item.


To Categorize
- app shifts slightly when using trackpad to scroll