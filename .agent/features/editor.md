# Feature: Tiptap Editor

## Status
Not started. Blocked by React migration + VaultContext.

## Goal
Replace the current CodeMirror editor with Tiptap (ProseMirror-based WYSIWYG).
Storage format is markdown strings in SQLite. Tiptap renders and edits them.

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

## Auto-save
- 800ms debounce after last keystroke (canonical — matches GOO-36)
- Flush immediately on: window blur, app close, `Mod+W` (close page)
- Call `updatePage(id, { content })` via VaultContext
- Save indicator: subtle icon state change (not a toast)

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
