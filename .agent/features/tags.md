# Feature: Tags

## Status
Not started. Depends on: storage (GOO-29), React migration (GOO-26).

## Goal
Full tag system: tagging pages, filtering by tag, tag rollup views. Tags are the primary
cross-folder organization mechanism.

## Storage
Tags are stored as a JSON array in `pages.tags` column (`TEXT NOT NULL DEFAULT '[]'`).
No separate `tags` table needed for v1 — derive tag metadata (counts, page lists) by querying pages.

```sql
-- Get all tags with page counts
SELECT value as tag, COUNT(*) as page_count
FROM pages, json_each(pages.tags)
GROUP BY value
ORDER BY page_count DESC;

-- Get pages for a specific tag
SELECT * FROM pages
WHERE json_array_length(tags) > 0
  AND EXISTS (
    SELECT 1 FROM json_each(tags) WHERE value = ?
  );
```

## Tag Entry Points
1. **MetadataHeader** — add/remove tags inline above editor (primary)
2. **Editor body** — `#tag` syntax in content (Phase 2, syncs to `tags` column on save)
3. **NL parser** — `#tag` in command palette input (GOO-19)

## Tag Views
- **Tags panel** in sidebar: list of all tags with page counts, click to open tag view
- **Tag view**: shows all pages with a given tag (replaces pages list for that context)
- **Filter by tag**: multi-select in pages list filter bar (GOO-38)
- **Calendar filter**: filter scheduled pages by tag (future)

## Tag Panel (sidebar)
Shows below folders panel or as a collapsible section:
```
Tags
  #work      12
  #health     5
  #ideas      3
```

## Tag Autocomplete
When adding a tag in MetadataHeader, autocomplete from existing tags in the vault.
Derive from VaultContext: `tags` derived via `useMemo` from `pages[]`.

## Tag Type (packages/core)
```ts
// Already in types.ts (GOO-27)
export interface Tag {
  name: string;
  pageCount: number;
  pageIds: string[];
}
```
Derived reactively in VaultContext — not a separate DB table.

## Tasks
- [ ] `TagBadge` component in `packages/ui`
- [ ] Tag add/remove in `MetadataHeader`
- [ ] Derive `tags: Tag[]` in VaultContext from `pages` array
- [ ] Tags panel in sidebar (collapsible section)
- [ ] Tag view (replaces pages list for selected tag)
- [ ] Tag filter in pages list filter bar (GOO-38)
- [ ] `#tag` syntax in editor body → sync to tags column on save (Phase 2)
