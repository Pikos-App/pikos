# Feature: Tiptap Editor

## Status
Not started. Blocked by React migration + WorkspaceContext.

## Goal
Replace the current CodeMirror editor with Tiptap (ProseMirror-based WYSIWYG).
Storage format is Tiptap JSON in SQLite. Markdown only appears at the import/export boundary.

## Packages
```
@tiptap/react
@tiptap/starter-kit
@tiptap/extension-task-list
@tiptap/extension-task-item
@tiptap/extension-placeholder
```
`tiptap-markdown` is NOT used at runtime — only needed if markdown import/export is added later.

## Components
- `EditorPane` — root editor wrapper, owns Tiptap instance + auto-save
- `MetadataHeader` — above the editor: title, status, priority, scheduled date, tags
- `EditorToolbar` — optional floating/fixed toolbar (Phase 2)

## No Tabs — explicit decision
There are no tabs in the editor. Ever. The page list panel is the navigation mechanism — it
already shows all pages in the current folder/view, supports J/K keyboard navigation, and
persists across page switches. Adding tabs would duplicate this and create cognitive overhead
("which of my 12 open tabs has that note?").

Opening a page always replaces the current editor content. `J`/`K`/`Enter` + `Cmd+P` are the
navigation primitives. If a user wants two pages visible simultaneously, that's what split view
is for (see below) — a deliberate, constrained affordance rather than an unbounded tab strip.

## Split View (GOO-81) — low priority
The right panel can optionally be split into two `EditorPane` instances, each showing an
independent page. Hard limit: **2 panes only**. No further splitting.

### Orientations
- **Left / Right** (default split): two panes side-by-side, each full height
- **Top / Bottom**: two panes stacked, each full width
- Toggle orientation after splitting via a button in the split header

### Layout
```
Split L/R (default):
┌──────────────────────┬──────────────────────┐
│ [◀] Page A    [⊟ ⋮] │ Page B        [× ⋮] │
│                      │                      │
│  editor content      │  editor content      │
│                      │                      │

Split T/B:
┌─────────────────────────────────────────────┐
│ [◀] Page A                           [⊟ ⋮] │
│  editor content                             │
├─────────────────────────────────────────────┤
│ Page B                                [× ⋮] │
│  editor content                             │
└─────────────────────────────────────────────┘
```

- `⊟` button on primary pane: toggle split orientation (L/R ↔ T/B)
- `×` button on secondary pane: close split, return to single pane
- Divider between panes is draggable (persist ratio in localStorage)
- Clicking a page in the page list opens it in the **focused** pane
  (focused pane = last clicked/typed-in; subtle border highlight indicates which)
- Calendar view ignores split — split only applies when `rightPanel === 'editor'`

### State
```ts
// Added to UIContext:
splitMode: 'none' | 'horizontal' | 'vertical'   // 'none' = no split
splitPageId: string | null   // activePage is primary; splitPageId is secondary
```
Persisted to `localStorage`. Both pages auto-save independently via their own `useAutosave`
instances.

### Keyboard
- `Cmd+Shift+\` — toggle split (cycles: none → horizontal → none; or none → last used orientation)
- `Cmd+Shift+[` / `Cmd+Shift+]` — move focus between panes

## Auto-save

Every field that a user can edit saves automatically — there is no manual save and no save button.
The strategy differs by field type:

### Save strategies by field

| Field | Strategy | Delay | Trigger |
|---|---|---|---|
| **Editor content** | Debounce | 800ms | Last keystroke |
| **Title** | Debounce | 500ms | Last keystroke |
| **Subtitle** | Debounce | 500ms | Last keystroke |
| **Status** | Immediate | — | Click |
| **Priority** | Immediate | — | Click |
| **Scheduled date/time** | Immediate | — | Picker confirm / close |
| **Tags** (add) | Immediate | — | Enter / comma / blur in tag input |
| **Tags** (remove) | Immediate | — | Click × on badge |
| **Folder** (move page) | Immediate | — | Drop / menu select |

"Immediate" = call `updatePage()` on the action itself, no debounce. These are discrete
user-initiated actions, not continuous input — debouncing them would feel broken.

"Debounce" = wait for the user to pause typing before writing to SQLite. Prevents a DB write
on every keystroke.

### Flush triggers (debounced fields only)
Pending debounced saves are flushed immediately — before the timeout fires — on:
- `window.blur` — app loses focus (user Cmd+Tab away)
- App close / Tauri `window.onCloseRequested`
- `activePage` changes — navigating to a different page
- `Mod+W` — close page shortcut

This ensures no data loss when a user types and immediately switches away.

### `useAutosave` hook
Shared hook used by editor content, title, and subtitle. Not used by immediate-save fields.

```ts
// packages/core/src/hooks/useAutosave.ts
function useAutosave<T>(
  value: T,
  saveFn: (val: T) => Promise<void>,
  options: { delay?: number } = {}   // default delay: 800ms
): { isDirty: boolean; isSaving: boolean; saveError: Error | null }
```

- Debounces `saveFn(value)` by `delay` ms
- Flushes on unmount (covers page switch + app close)
- Returns `isDirty` (unsaved changes exist), `isSaving` (async in-flight), `saveError`
- The caller is responsible for wiring `window.blur` flush via a `useEffect`

`EditorPane`, `TitleField`, and `SubtitleField` each instantiate their own `useAutosave`.
They share the same `updatePage()` from WorkspaceContext but track dirty state independently.

### Save indicator
A single indicator per page — not per field. Lives in the `MetadataHeader` next to the title.

```
States:
  (nothing)          — all saved, clean
  ●  saving...       — any field has a pending debounce OR an in-flight save
  ✓  saved           — just completed, fades out after 1.5s
  ⚠  save failed     — persistent until next successful save; click to retry
```

- "Saving" state consolidates all fields — one dot covers title + content + subtitle together
- Toast is NOT used for save feedback (too noisy for continuous autosave)
- Error state is sticky — the user must see it; silent data loss is unacceptable

### Error handling
If `updatePage()` rejects:
1. `saveError` is set on the relevant `useAutosave` instance
2. Indicator switches to ⚠ state
3. The in-memory value in WorkspaceContext is still current — nothing is lost, just not persisted
4. On next edit (any field) the save is retried automatically
5. If the error persists, the indicator stays ⚠ — user can click it for a "Retry now" action

## Content Storage Format
**Tiptap JSON** is stored in SQLite (not markdown). This is the canonical format.

- On page load: `editor.commands.setContent(JSON.parse(page.content))` — direct, no conversion
- On save: `editor.getJSON()` → `JSON.stringify()` → `updatePage({ content, contentText })`
- `contentText`: plain text extracted from the JSON for FTS indexing (see `packages/core/src/utils/extractText.ts`)
- Markdown only appears at the import/export boundary (GOO-48/49) — not in the edit loop

## New Page UX (Cmd+N)
- Auto-creates a page with empty title and content immediately
- Page appears in the pages list and editor opens
- Title field in `MetadataHeader` is auto-focused so user can type the title right away
- No modal, no rename step — inline title editing

## Task List vs Page Status — important distinction
These are **two separate things**:

| | Tiptap Task List | Page Status |
|--|--|--|
| What | Inline `[ ]` / `[x]` checkboxes inside the document body | The page-level `status` field (`not_started` / `in_progress` / `done`) |
| Where | Stored in `content` markdown string as `- [ ] item` | Stored as `status` column in SQLite |
| UI | Rendered as interactive checkboxes within the editor | Status toggle in `MetadataHeader` |
| Scope | Individual to-do items within a page | The completion state of the page as a whole |

Do NOT wire task list checkbox state to the page `status` field.

## Keyboard Scope
- Editor shortcuts run in `editor` scope (pushed on focus, popped on blur)
- Global shortcuts (`Mod+P`, `Mod+N`, etc.) remain active in all scopes

## Phase 1 Extensions
- Bold, italic, strikethrough (`StarterKit` covers these)
- Headings H1–H3
- Bullet list, ordered list
- Task list with interactive checkboxes (`TaskList` + `TaskItem`)
- Code block
- Placeholder text when editor is empty
- Markdown paste (via `tiptap-markdown`)

## Phase 2 Extensions
- Link with preview
- Image (inline)
- Table
- `[[wikilink]]` autocomplete (GOO-13)
- Mentions (@page links)

## Mobile Consideration (deferred)
ProseMirror/Tiptap is DOM-based and cannot run natively in React Native — a WebView is required
either way. Options when mobile work starts:

1. **WebView wrapping Tiptap** — simplest, maximum code reuse. The same `EditorPane` component
   runs inside a `WebView` on mobile. Acceptable UX for a notes app.
2. **Simplified native editor** — plain text input or a lightweight RN markdown editor for mobile,
   full Tiptap on desktop only.

Decision deferred to when `apps/mobile` work begins.

## Upgrade Path
If performance becomes a bottleneck at scale: Tiptap → ProseMirror direct is a component-level
swap. Tiptap is a configuration/extension layer over ProseMirror — stripping it back keeps all
extension logic intact, just removes the DX wrapper. `EditorPane` isolation is what makes this
feasible without an app-wide refactor.

## Acceptance Criteria
- Editing a page saves Tiptap JSON to SQLite with no data loss
- `content_text` is correctly extracted and FTS search finds the page
- Exported markdown (via GOO-49) is Obsidian-readable
- No raw markdown syntax visible while typing (WYSIWYG)
- Task checkboxes are interactive within the document body
