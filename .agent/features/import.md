# Import — Feature Spec

## Goal

Let users bring existing data into Pikos from other apps. Pre-launch scope: two importers covering the widest audience with minimal effort.

## Importers

### 1. Markdown / Obsidian Vault

**Input**: A folder selected via native file picker. May contain `.md` files at any depth.

**Mapping**:
| Source | Pikos field |
|--------|-------------|
| Filename (minus `.md`) | `title` |
| YAML frontmatter `tags` | `tags` (array) |
| YAML frontmatter `status` (`done`, `completed`, `x`) | `status: "done"`, `completedAt: now` |
| YAML frontmatter `priority` (1–4 or urgent/high/medium/low) | `priority` (0–4) |
| YAML frontmatter `due` or `scheduled` (ISO date) | `scheduledStart` (all-day) |
| YAML frontmatter `created` (ISO date) | `createdAt` |
| Markdown body | `content` (Tiptap JSON via `tiptap-markdown`) |
| `[[wikilinks]]` in body | `links` (resolved to page IDs post-import) |
| Leaf directory path | Pikos folder (flattened, see below) |

**Folder flattening**: Leaf directories (those containing `.md` files) become Pikos folders. The full path from the vault root is joined with ` / ` as separator.

```
vault/
  Projects/
    Work/
      note1.md    → folder "Projects / Work"
    Personal/
      note2.md    → folder "Projects / Personal"
  Daily/
    2024-01-01.md → folder "Daily"
```

Intermediate directories with no direct `.md` files are absorbed into child paths (no empty folders created).

**Unsupported content**: Embedded images (`![[image.png]]`, `![](path)`), Mermaid diagrams, dataview queries, callouts, and other non-standard Markdown blocks are converted to fenced code blocks with a comment noting the original type. This preserves the content without data loss.

### 2. CSV (TickTick / Todoist)

**Input**: A `.csv` file selected via native file picker.

**Auto-detection**: Parser inspects the header row to determine source:
- TickTick: headers include `Folder Name`, `Status`, `Title`, `Content`, `Due Date`, `Priority`, `Tags`
- Todoist: headers include `TYPE`, `CONTENT`, `PRIORITY`, `INDENT`, `DATE`, `PROJECT`

**Mapping (TickTick)**:
| CSV column | Pikos field |
|-----------|-------------|
| `Title` | `title` |
| `Content` | `content` (plain text wrapped in Tiptap paragraph) |
| `Folder Name` / `List Name` | folder (created if not exists) |
| `Status` (0=active, 2=completed) | `status`, `completedAt` |
| `Priority` (0=none, 1=low, 3=medium, 5=high) | `priority` (mapped to 0/4/3/2) |
| `Tags` | `tags` (split on comma) |
| `Due Date` | `scheduledStart` (all-day) |
| `Created Date` | `createdAt` |

**Mapping (Todoist)**:
| CSV column | Pikos field |
|-----------|-------------|
| `CONTENT` | `title` |
| `DESCRIPTION` | `content` (plain text wrapped in Tiptap paragraph) |
| `PROJECT` | folder (created if not exists) |
| `PRIORITY` (1=p4, 2=p3, 3=p2, 4=p1 — Todoist inverts) | `priority` (mapped: 4→1, 3→2, 2→3, 1→4) |
| `DATE` | `scheduledStart` (all-day) |
| `LABELS` | `tags` (split on comma) |

Todoist rows with `TYPE=section` are skipped (Pikos has no section concept). Rows with `TYPE=note` are imported as sub-content of the preceding task if possible, otherwise as standalone pages.

## UX Flow

### Entry point

Settings → General → new "Import" section (between Export and Feedback). Two buttons:
- "Import Markdown / Obsidian Vault" → opens native folder picker
- "Import CSV (TickTick, Todoist)" → opens native file picker (`.csv` filter)

### Preview screen

After file/folder selection, a full-width modal overlay shows:

1. **Summary bar**: "Found X pages in Y folders with Z tags"
2. **Warnings panel** (if any):
   - "N nested directories will be flattened into folder names"
   - "N files had unsupported content (preserved as code blocks)"
   - "N files had no content (title-only pages)"
   - "Folder 'X' already exists — imported pages will be added to it"
3. **Preview tree**: Expandable folder → page list showing:
   - Folder name (with flatten indicator if applicable)
   - Page title, status icon, priority badge, tag chips, scheduled date
   - Truncated content preview (first ~100 chars)
4. **Action buttons**:
   - "Cancel" — closes modal, nothing happens
   - "Import X pages" — primary button, executes import

### During import

- Progress bar: "Importing page N of X..."
- Non-blocking — user can't navigate away but sees progress

### After import

- Toast: "Imported X pages into Y folders. Undo"
- "Undo" link in toast soft-deletes all imported items (batch operation)
- Imported items are tagged with metadata `_import_batch: <timestamp>` for batch undo (stored as a regular tag, hidden from UI if prefixed with `_`)

## Safety

### Pre-import SQLite backup

Before any write, copy the workspace `.sqlite` file to `{appDataDir}/backups/pre-import-{timestamp}.sqlite` using SQLite `VACUUM INTO`. This is the nuclear undo option.

### Batch undo

All imported pages and folders carry a shared batch tag (`_import_YYYYMMDD_HHMMSS`). The "Undo Import" action:
1. Soft-deletes all pages with the batch tag
2. Soft-deletes any folders that were created by the import (empty after page removal)
3. Removes the batch tag entry

Undo is available via:
- Toast immediately after import
- Settings → General → Import History (shows past imports with "Undo" button, limited to imports with non-deleted pages)

## Architecture

### Frontend-only parsing

All parsing happens in the browser/webview — no Rust commands needed for parsing. This keeps the parser testable with Vitest and avoids IPC overhead for potentially thousands of files.

**File reading**: Use `@tauri-apps/plugin-fs` (already a dependency) to read files from the selected directory. For Markdown vaults, recursively list directory contents and read each `.md` file.

**Markdown → Tiptap**: Use the existing `tiptap-markdown` extension. Create a headless Tiptap editor instance (no DOM), feed it markdown via `editor.commands.setContent(markdownString)`, then extract the JSON via `editor.getJSON()`. Destroy the editor after each file.

**CSV parsing**: Use a lightweight CSV parser (e.g., `papaparse`, ~7KB gzipped) or hand-roll a simple one since the CSV formats are well-known and simple.

### Batch write

After preview confirmation, write all data through the existing `StorageAdapter` interface:
1. `createFolder()` for each new folder
2. `createPage()` for each page (with resolved `folderId`)
3. Post-process: resolve `[[wikilinks]]` to page IDs, `updatePage()` with `links` array

### New Rust command

`backup_db_before_import` — similar to existing `backup_db` but writes to `{appDataDir}/backups/` instead of `~/Downloads/`.

## File structure

```
apps/desktop/src/features/import/
  index.ts                    — public exports
  components/
    ImportSection.tsx          — Settings UI section with import buttons
    ImportPreviewModal.tsx     — Full preview overlay
  parsers/
    markdown.ts               — Markdown/Obsidian vault parser
    markdown.test.ts           — Parser tests
    csv.ts                     — CSV parser (TickTick + Todoist)
    csv.test.ts                — Parser tests
    types.ts                   — Shared parser output types (ImportPlan, ImportPage, ImportFolder)
  hooks/
    useImport.ts               — Orchestrates parse → preview → execute → undo flow
```

## Out of scope (for now)

- Notion database imports (complex JSON, low ROI vs Notion's own MD export)
- Apple Notes / Reminders (no clean export path)
- Nested folder creation (flat v1 constraint)
- Image import (would need to copy files to assets dir — future enhancement)
- Incremental / delta import (always full import, dedup by title+folder in preview)
- Two-way sync with any source
