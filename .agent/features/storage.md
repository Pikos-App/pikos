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
CREATE TABLE IF NOT EXISTS folders (
  id          TEXT PRIMARY KEY,   -- UUID
  name        TEXT NOT NULL,
  parent_id   TEXT REFERENCES folders(id) ON DELETE SET NULL,
  color       TEXT,
  icon        TEXT,
  created_at  TEXT NOT NULL,      -- ISO 8601
  updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS pages (
  id              TEXT PRIMARY KEY,   -- UUID
  folder_id       TEXT REFERENCES folders(id) ON DELETE SET NULL,
  title           TEXT NOT NULL DEFAULT '',
  content         TEXT NOT NULL DEFAULT '{}', -- Tiptap JSON string (NOT markdown)
  content_text    TEXT NOT NULL DEFAULT '',   -- plain text extracted from JSON, for FTS
  status          TEXT NOT NULL DEFAULT 'not_started',
  priority        INTEGER NOT NULL DEFAULT 0,
  tags            TEXT NOT NULL DEFAULT '[]', -- JSON array
  scheduled_start TEXT,
  scheduled_end   TEXT,
  completed_at    TEXT,
  duration_mins   INTEGER,
  links           TEXT DEFAULT '[]',          -- JSON array of [[wikilink]] targets
  parent_id       TEXT REFERENCES pages(id) ON DELETE SET NULL,
  last_opened_at  TEXT,                       -- ISO 8601, updated on setActivePage()
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

-- FTS5 indexes content_text (plain text extracted from Tiptap JSON), not content (JSON)
CREATE VIRTUAL TABLE IF NOT EXISTS pages_fts USING fts5(
  title, content_text, tags,
  content=pages, content_rowid=rowid
);

-- Keep FTS in sync automatically
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

// src-tauri/src/db/search.rs
#[tauri::command] async fn search_pages(db: State<'_, DbPool>, query: String) -> Result<Vec<SearchResult>, String>
// SearchResult { id: String, title: String, excerpt: String }

// src-tauri/src/db/folders.rs
#[tauri::command] async fn create_folder(db: State<'_, DbPool>, data: NewFolder) -> Result<Folder, String>
#[tauri::command] async fn get_folder(db: State<'_, DbPool>, id: String) -> Result<Option<Folder>, String>
#[tauri::command] async fn update_folder(db: State<'_, DbPool>, id: String, updates: FolderUpdate) -> Result<Folder, String>
#[tauri::command] async fn delete_folder(db: State<'_, DbPool>, id: String) -> Result<(), String>
#[tauri::command] async fn list_folders(db: State<'_, DbPool>) -> Result<Vec<Folder>, String>
```
All return `Result<T, String>`. Structs derive `serde::Serialize + serde::Deserialize`.

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
interface TiptapNode { type: string; text?: string; content?: TiptapNode[] }

export function extractText(node: TiptapNode): string {
  if (node.type === 'text') return node.text ?? ''
  return (node.content ?? []).map(extractText).join(' ')
}
```

`updatePage` call site:
```ts
const contentText = extractText(JSON.parse(content))
await adapter.updatePage(id, { content, contentText })
```

## StorageAdapter Interface (TypeScript)
Lives in `packages/core/src/storage.ts`.
```ts
export type NewPage = Omit<Page, 'id' | 'createdAt' | 'updatedAt'>;
export type PageUpdate = Partial<Omit<Page, 'id' | 'createdAt' | 'updatedAt'>>;
export type NewFolder = Omit<Folder, 'id' | 'createdAt' | 'updatedAt'>;
export type FolderUpdate = Partial<Omit<Folder, 'id' | 'createdAt' | 'updatedAt'>>;

export interface StorageAdapter {
  getPage(id: string): Promise<Page | null>;
  createPage(data: NewPage): Promise<Page>;
  updatePage(id: string, updates: PageUpdate): Promise<Page>;
  deletePage(id: string): Promise<void>;
  listPages(filter?: PageFilter): Promise<Page[]>;
  searchPages(query: string): Promise<SearchResult[]>; // returns excerpts, not full pages
  getFolder(id: string): Promise<Folder | null>;
  createFolder(data: NewFolder): Promise<Folder>;
  updateFolder(id: string, updates: FolderUpdate): Promise<Folder>;
  deleteFolder(id: string): Promise<void>;
  listFolders(): Promise<Folder[]>;
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
    import.meta.env.VITE_TEST_MODE === 'true'
      ? new MockStorageAdapter()
      : new TauriSQLiteAdapter()
  )
  // ...
}
```

`useState` lazy initializer runs once on mount — adapter instance is stable for the component lifetime.

## DB Location
Tauri app data dir — platform-appropriate (not hardcoded). `~/.pkos/vault.db` on macOS approximately.

## Privacy Story
"Your data is in a SQLite file on your device. We have no servers. We cannot read your notes."
