# Feature: Search & Command Palette

## Status
Not started. Depends on: React migration (GOO-26), FTS5 in SQLite (GOO-29).

## Command Palette (GOO-17)
Upgrade the existing `PageSwitcher` modal into the app's primary command hub.

**Triggers:**
- `Cmd+P` → page title search (fuzzy, replaces current PageSwitcher)
- `Cmd+P` twice → switches to content search
- `Cmd+K` → actions palette (create page, switch vault, open settings, etc.)

**Layout:**
- Full-width input at top
- Results: recent pages section + fuzzy matches
- Actions section: "New Page", "Switch Vault", keyboard shortcut hints
- Keyboard nav: ↑↓ arrows, Enter to select, Esc to close

**Two search code paths:**
- **Title search** — `fuse.js` against `pages[]` in VaultContext memory. Immediate, no DB round-trip. Typo-tolerant with relevance scoring.
- **Content search** — FTS5 via `search_pages` Tauri command, triggered on `Cmd+P` double-tap. Returns `SearchResult[]` with highlighted excerpts.

**Natural language in input:**
- Parsed by GOO-19 NL parser (`chrono-node` + custom tokenizer) to pre-fill page metadata on creation
- e.g., "standup @tomorrow 9am #work" → creates page with title "standup", scheduled tomorrow 9am, tagged "work"

## FTS5 Content Search (GOO-18)
SQLite FTS5 virtual table on `pages.content_text` (plain text extracted from Tiptap JSON — NOT the raw JSON in `pages.content`). Also indexes `title` and `tags`.

> Note: GOO-18 was originally described with a filesystem file watcher. That approach is **superseded** — content is in SQLite now. Updates happen on page save (auto-save), not via file watch.

**Tauri command:** `search_pages(query: String) -> Vec<SearchResult>`

**SearchResult type** (in `packages/core/src/types.ts`):
```ts
export interface SearchResult {
  id: string;
  title: string;
  excerpt: string; // highlighted snippet with <mark> tags
}
```

**SQL:**
```sql
SELECT pages.id, pages.title,
  snippet(pages_fts, 1, '<mark>', '</mark>', '…', 20) as excerpt
FROM pages_fts
JOIN pages ON pages.rowid = pages_fts.rowid
WHERE pages_fts MATCH ?
ORDER BY rank
```
Note: snippet column index 1 = `content_text` (0=title, 1=content_text, 2=tags).

**Result display:** title + highlighted excerpt snippet. Full page loaded from VaultContext on selection.
