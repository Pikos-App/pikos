# Feature: SQLite Storage

## Status

Not started. Blocked by React migration scaffold (GOO-26).

## Goal

SQLite as the single source of truth. No filesystem as storage. DB lives in Tauri app data dir.

## Cargo.toml

```toml
[dependencies]
tauri-plugin-sql = { version = "2", features = ["sqlite"] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
uuid = { version = "1", features = ["v4"] }

# Added for CalDAV sync (GOO-22)
reqwest = { version = "0.12", features = ["json"] }
ical = "0.10"
keyring = "2"   # OS keychain: macOS Keychain / Windows Credential Manager
```

## Schema — `src-tauri/migrations/001_initial.sql`

```sql
-- ─── Folders ─────────────────────────────────────────────────────────────────
-- v1: flat list only. parent_id always NULL — nested folders NOT implemented.
-- Schema is shaped to support nesting later without a migration.
CREATE TABLE IF NOT EXISTS folders (
  id          TEXT PRIMARY KEY,   -- UUID
  name        TEXT NOT NULL,
  parent_id   TEXT REFERENCES folders(id) ON DELETE SET NULL,
                                  -- always NULL in v1; reserved for future nesting
  sort_order  INTEGER NOT NULL DEFAULT 0,
                                  -- manual position in the flat folder list
  color       TEXT,
  icon        TEXT,
  created_at  TEXT NOT NULL,      -- ISO 8601
  updated_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_folders_sort ON folders(sort_order);

-- ─── Pages ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS pages (
  id              TEXT PRIMARY KEY,   -- UUID
  folder_id       TEXT REFERENCES folders(id) ON DELETE SET NULL,
  title           TEXT NOT NULL DEFAULT '',
  content         TEXT NOT NULL DEFAULT '{}', -- Tiptap JSON string (NOT markdown)
  content_text    TEXT NOT NULL DEFAULT '',   -- plain text for FTS (extracted on save)
  status          TEXT NOT NULL DEFAULT 'not_started',
  priority        INTEGER NOT NULL DEFAULT 0,
  tags            TEXT NOT NULL DEFAULT '[]', -- JSON array of tag strings
  sort_order      INTEGER NOT NULL DEFAULT 0, -- manual position within folder (or inbox)
  scheduled_start TEXT,                       -- ISO 8601
  scheduled_end   TEXT,                       -- ISO 8601
  completed_at    TEXT,
  duration_mins   INTEGER,
  links           TEXT DEFAULT '[]',          -- JSON array of [[wikilink]] page IDs
  parent_id       TEXT REFERENCES pages(id) ON DELETE SET NULL,
                                              -- sub-page nesting (GOO-12, max 3 levels)
  rrule           TEXT,                       -- iCal RRULE string (infinite recurrence template)
                                              -- NULL = not a recurring template
                                              -- Calendar expands dynamically via rrule.js; no rows pre-generated
                                              -- Finite recurrence produces N independent pages (rrule = NULL on each)
  last_opened_at  TEXT,                       -- ISO 8601, updated on setActivePage()
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

-- Indexes for common query patterns at scale
CREATE INDEX IF NOT EXISTS idx_pages_folder_sort    ON pages(folder_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_pages_status         ON pages(status);
CREATE INDEX IF NOT EXISTS idx_pages_scheduled      ON pages(scheduled_start);
CREATE INDEX IF NOT EXISTS idx_pages_priority       ON pages(priority);
CREATE INDEX IF NOT EXISTS idx_pages_last_opened    ON pages(last_opened_at);
CREATE INDEX IF NOT EXISTS idx_pages_parent         ON pages(parent_id);
CREATE INDEX IF NOT EXISTS idx_pages_completed_at   ON pages(completed_at);
CREATE INDEX IF NOT EXISTS idx_pages_rrule          ON pages(rrule) WHERE rrule IS NOT NULL;
                                              -- partial index: only rows that are recurrence templates

-- ─── FTS5 ────────────────────────────────────────────────────────────────────
-- Indexes content_text (plain text extracted from Tiptap JSON), not raw JSON
CREATE VIRTUAL TABLE IF NOT EXISTS pages_fts USING fts5(
  title, content_text, tags,
  content=pages, content_rowid=rowid
);

CREATE TRIGGER IF NOT EXISTS pages_fts_insert AFTER INSERT ON pages BEGIN
  INSERT INTO pages_fts(rowid, title, content_text, tags)
  VALUES (new.rowid, new.title, new.content_text, new.tags);
END;

CREATE TRIGGER IF NOT EXISTS pages_fts_update AFTER UPDATE ON pages BEGIN
  INSERT INTO pages_fts(pages_fts, rowid, title, content_text, tags)
  VALUES ('delete', old.rowid, old.title, old.content_text, old.tags);
  INSERT INTO pages_fts(rowid, title, content_text, tags)
  VALUES (new.rowid, new.title, new.content_text, new.tags);
END;

CREATE TRIGGER IF NOT EXISTS pages_fts_delete AFTER DELETE ON pages BEGIN
  INSERT INTO pages_fts(pages_fts, rowid, title, content_text, tags)
  VALUES ('delete', old.rowid, old.title, old.content_text, old.tags);
END;
```

## Recent Pages

Tracked via `last_opened_at` column — persists across restarts.

```sql
-- Query recent pages (for command palette / PageSwitcher)
SELECT * FROM pages
WHERE last_opened_at IS NOT NULL
ORDER BY last_opened_at DESC
LIMIT 10;
```

`VaultContext.setActivePage()` calls `updatePage(id, { lastOpenedAt: new Date().toISOString() })` on every page open.

## Tauri Commands (Rust signatures)

```rust
// src-tauri/src/db/pages.rs
#[tauri::command] async fn create_page(db: State<'_, DbPool>, data: NewPage) -> Result<Page, String>
#[tauri::command] async fn get_page(db: State<'_, DbPool>, id: String) -> Result<Option<Page>, String>
#[tauri::command] async fn update_page(db: State<'_, DbPool>, id: String, updates: PageUpdate) -> Result<Page, String>
#[tauri::command] async fn delete_page(db: State<'_, DbPool>, id: String) -> Result<(), String>
#[tauri::command] async fn list_pages(db: State<'_, DbPool>, filter: Option<PageFilter>) -> Result<Vec<Page>, String>
// Reorder: update sort_order for all pages in a folder in one transaction.
// ordered_ids = full ordered list of page IDs for that folder_id (or null = inbox).
#[tauri::command] async fn reorder_pages(db: State<'_, DbPool>, folder_id: Option<String>, ordered_ids: Vec<String>) -> Result<(), String>

// src-tauri/src/db/search.rs
#[tauri::command] async fn search_pages(db: State<'_, DbPool>, query: String) -> Result<Vec<SearchResult>, String>
// SearchResult { id: String, title: String, excerpt: String }

// src-tauri/src/db/folders.rs
#[tauri::command] async fn create_folder(db: State<'_, DbPool>, data: NewFolder) -> Result<Folder, String>
#[tauri::command] async fn get_folder(db: State<'_, DbPool>, id: String) -> Result<Option<Folder>, String>
#[tauri::command] async fn update_folder(db: State<'_, DbPool>, id: String, updates: FolderUpdate) -> Result<Folder, String>
#[tauri::command] async fn delete_folder(db: State<'_, DbPool>, id: String) -> Result<(), String>
#[tauri::command] async fn list_folders(db: State<'_, DbPool>) -> Result<Vec<Folder>, String>
// Reorder: update sort_order for all folders in one transaction.
#[tauri::command] async fn reorder_folders(db: State<'_, DbPool>, ordered_ids: Vec<String>) -> Result<(), String>
```

All return `Result<T, String>`. Structs derive `serde::Serialize + serde::Deserialize`.

### Reorder implementation (Rust sketch)

// TODO: consider doing a more scalable sort, where we only need to update the one record when it is moved - if item a is order 0 and item c is order 1, and item b is order 3 - then you move item b between item a and c, item b would be order 1.5. This is a rudimentary mechanism for sorting items in a massive list without updating all items order fields. I believe you can use a series of numbers and letters for the sorting mechanism (Jira does this I believe).

```rust
// UPDATE pages SET sort_order = ? WHERE id = ? — run for each (index, id) pair in a txn
async fn reorder_pages(db: State<'_, DbPool>, folder_id: Option<String>, ordered_ids: Vec<String>) -> Result<(), String> {
    let mut conn = db.acquire().await.map_err(|e| e.to_string())?;
    let mut txn = conn.begin().await.map_err(|e| e.to_string())?;
    for (i, id) in ordered_ids.iter().enumerate() {
        sqlx::query("UPDATE pages SET sort_order = ?, updated_at = ? WHERE id = ?")
            .bind(i as i64)
            .bind(now_iso8601())
            .bind(id)
            .execute(&mut *txn)
            .await
            .map_err(|e| e.to_string())?;
    }
    txn.commit().await.map_err(|e| e.to_string())
}
```

## Search Query (FTS5)

```sql
SELECT pages.id, pages.title,
  snippet(pages_fts, 1, '<mark>', '</mark>', '…', 20) AS excerpt
FROM pages_fts
JOIN pages ON pages.rowid = pages_fts.rowid
WHERE pages_fts MATCH ?
ORDER BY rank
```

Note: FTS snippet column index 1 = `content_text` (0=title, 1=content_text, 2=tags).

## Content Text Extraction (TypeScript)

Called on the TS side before `updatePage` — extracts plain text from Tiptap JSON for FTS.

```ts
// packages/core/src/utils/extractText.ts
interface TiptapNode {
  type: string;
  text?: string;
  content?: TiptapNode[];
}

export function extractText(node: TiptapNode): string {
  if (node.type === "text") return node.text ?? "";
  return (node.content ?? []).map(extractText).join(" ");
}
```

`updatePage` call site:

```ts
const contentText = extractText(JSON.parse(content));
await adapter.updatePage(id, { content, contentText });
```

## StorageAdapter Interface (TypeScript)

Lives in `packages/core/src/storage.ts`.

```ts
// sort_order excluded from NewPage/NewFolder — backend assigns max+1 on create
export type NewPage = Omit<Page, "id" | "createdAt" | "updatedAt" | "sortOrder">;
export type PageUpdate = Partial<Omit<Page, "id" | "createdAt" | "updatedAt">>;
export type NewFolder = Omit<Folder, "id" | "createdAt" | "updatedAt" | "sortOrder">;
export type FolderUpdate = Partial<Omit<Folder, "id" | "createdAt" | "updatedAt">>;

export interface StorageAdapter {
  getPage(id: string): Promise<Page | null>;
  createPage(data: NewPage): Promise<Page>;
  updatePage(id: string, updates: PageUpdate): Promise<Page>;
  deletePage(id: string): Promise<void>;
  listPages(filter?: PageFilter): Promise<Page[]>;
  // orderedIds = complete ordered list for that folderId (null = inbox/no folder)
  reorderPages(folderId: string | null, orderedIds: string[]): Promise<void>;
  searchPages(query: string): Promise<SearchResult[]>; // returns excerpts, not full pages
  getFolder(id: string): Promise<Folder | null>;
  createFolder(data: NewFolder): Promise<Folder>;
  updateFolder(id: string, updates: FolderUpdate): Promise<Folder>;
  deleteFolder(id: string): Promise<void>;
  listFolders(): Promise<Folder[]>;
  reorderFolders(orderedIds: string[]): Promise<void>;
}
```

## Implementations

- `TauriSQLiteAdapter` → `apps/desktop/src/shared/adapters/TauriSQLiteAdapter.ts`
  Calls `invoke('create_page', ...)` etc. from `@tauri-apps/api/core`.
  Lives in `apps/desktop/` (not `packages/core`) — has Tauri deps.
- `MockStorageAdapter` → `packages/core/src/adapters/MockStorageAdapter.ts`
  In-memory Maps. Used in Playwright + Vitest tests via `VITE_TEST_MODE`.

## Adapter Injection

No separate `StorageContext` needed. The adapter is created once inside `VaultProvider` using a lazy state initializer:

```ts
// apps/desktop/src/shared/context/VaultContext.tsx
export function VaultProvider({ children }: { children: React.ReactNode }) {
  const [adapter] = useState<StorageAdapter>(() =>
    import.meta.env.VITE_TEST_MODE === "true" ? new MockStorageAdapter() : new TauriSQLiteAdapter()
  );
  // ...
}
```

`useState` lazy initializer runs once on mount — adapter instance is stable for the component lifetime.

## Multi-Vault

Each vault is a **separate SQLite file**. The list of known vaults is tracked in a lightweight
config stored via `@tauri-apps/plugin-store` (JSON, not SQLite — no schema migration needed for config).

### Vault config shape (`@tauri-apps/plugin-store`, key: `vaults`)

```ts
// packages/core/src/types.ts
export interface Vault {
  id: string; // UUID, stable identifier across renames
  name: string; // display name (user-editable)
  dbPath: string; // absolute path to the vault .sqlite file
  createdAt: string; // ISO 8601
  lastOpenedAt: string | null;
}
```

Stored as `Vault[]` under the key `"vaults"` in plugin-store. `lastOpenedAt` determines which
vault to auto-open on launch. The vault's own SQLite file contains no knowledge of other vaults.

### Why separate files (not one DB with a vault_id column)

- Each vault file is self-contained → drag-and-drop backup, share with collaborators
- No cross-contamination if a vault file is corrupted
- Sync (Phase 4) will be per-vault, tied to a user account — separate files map cleanly

### `VaultContext.selectVault()`

Open vault picker dialog → user selects folder → create `<folder>/pikos.db` if new, or open
existing. Upsert `Vault` record in plugin-store. Set as `lastOpenedAt`. Connect adapter to
the new DB path.

## DB Location

Each vault: user-chosen folder (via `@tauri-apps/plugin-dialog` folder picker). Default suggestion:
`~/Documents/Pikos/<vault-name>/pikos.db`. Stored as absolute path in `Vault.dbPath`.

## Privacy Story

"Your data is in a SQLite file on your device. We have no servers. We cannot read your notes."
