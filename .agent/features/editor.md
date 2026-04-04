# Feature: Editor — Future Work & Key Decisions

## Key Decisions (non-obvious, not derivable from code)

### No Tabs — Ever
The page list panel is the navigation mechanism. No tabs. Opening a page replaces the current
editor content. `J`/`K`/`Enter` + `Cmd+K` are the navigation primitives. Split view is the
constrained affordance for side-by-side viewing (2 panes max).

### Content Storage = Tiptap JSON
Tiptap JSON in SQLite is canonical. Markdown only at import/export boundary.

### Task List vs Page Status — Separate Concerns
Inline `[ ]` checkboxes in editor body are independent from `pages.status`. Never wire them together.

### Two-Layer Debouncing
`useAutosave` 800ms + `WorkspaceContext` 800ms = ~1.6s worst-case keystroke-to-disk.
Optimistic UI always current. Flush on blur/close/page-switch.

## Unbuilt Features

- **Split view (GOO-81)**: Two `EditorPane` instances, hard limit 2. L/R or T/B orientation. `Cmd+Shift+\` toggle. State: `UIContext.splitMode` + `splitPageId`. Low priority.
- **Wikilink autocomplete (GOO-13)**: `[[` triggers page title autocomplete. Backlinks panel shows inbound links.
- **Drag handle (GOO-105)**: Grip icon for block reorder. Custom ProseMirror NodeView (paid extension avoided). De-prioritized post-launch.
- **Image + table support**: Not yet implemented.
