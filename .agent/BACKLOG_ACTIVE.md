# Pikos — Active Backlog

Working queue from Phase 2 through Public Launch. Ordered by the sequence things need to ship.
For post-launch specs — grep `BACKLOG.md` by GOO number.

Status: `[ ]` pending · Delete task when done.

---

## Phase 2A — Core Editor & Metadata

### Enhancements

- [ ] **GOO-108** Tab key behavior in editor _(High)_
  Tab/Shift+Tab intercepted — no longer moves browser focus. Lists: indent/outdent ✓. Task items: indent/outdent ✓. Code blocks: insert/remove 2 spaces ✓. **Remaining:** Tab in normal paragraphs should insert/remove indentation (insertText with spaces not working in paragraph nodes — needs investigation).

## 🚀 Friends Beta Gate

styling refinement
- [ ] tab and focus styling behavior, tab group and focus trap components?
- [ ] compact pageblock children rendering

- [ ] First-time user content / tutorial — **seeded tutorial data** (like Obsidian's sample vault), triggered on first workspace creation.
  - Create `apps/desktop/src/shared/seeds/tutorial.ts` — port `scripts/seed/seed-tutorial.ts` to use `StorageAdapter` (follow `marketing.ts` pattern). Dynamic dates via `new Date()`. Returns `{ welcomePageId, folderId }`.
  - In `WorkspaceContext.selectWorkspace()`: call `seedTutorial(adapter)` after `connectDb()`. Store result in a `pendingNavigationRef`. Expose `consumePendingNavigation()` on context.
  - In `App.tsx` `AppShell`: one-shot effect consumes pending navigation → `setActiveViewId(folderId)` + `openPage(welcomePageId)`.
  - Add `VITE_SEED=tutorial` support in the test-mode seed switch.
  - Full plan: `.claude/plans/peppy-foraging-lerdorf.md`
  - Make sure to update test coverage to reflect this change - I want a test to confirm this data seeds correctly. And you may need to update existing coverage to not click through the "get started" button.
  - And the record-hero.sh and record-hero.spec.ts might need to be updated based on this change.

- [ ] Misc dogfooding improvements.

## Enhancements

- [ ] **Local usage stats** — SQL-powered stats panel (settings or debug view) showing aggregate usage: total pages, folders, scheduled pages, focus sessions; pages by status; pages created per week; feature adoption flags (has scheduled page, has folder, etc.). No telemetry — all queries run against the local DB. During beta, users can screenshot or share voluntarily.

## Performance

### Performance scaling tasks

- [ ] Lazy load completed records — don't fetch completed pages until the "Completed" section is expanded. Keeps initial query fast as completed count grows over months. Only fetch 20 completed at a time, with conditional load more button below completed records.
- [ ] Virtualize page/folder lists with `react-virtual` (TanStack Virtual) — required once a folder has 100+ pages. Without it, DOM node count scales linearly and folder switch slows down.

---

## Perf test upgrades (future)

Current perf tests (`e2e/perf.spec.ts`, `perf.prod.spec.ts`, `scripts/check-bundle-size.sh`) only cover the JS layer — React rendering, bundle size, long tasks. They run against Vite (dev or preview), not the Tauri webview. MockStorageAdapter is in the loop, not real SQLite.

**Not covered:**
- SQLite query latency (need Rust-side benchmarks, e.g. criterion)
- Tauri IPC overhead (invoke round-trip)
- WebView cold start (need tauri-driver + WebdriverIO)
- Real I/O paths
- **Realistic data volume testing**: seed a DB with 10000+ pages, 5000+ schedules, deep folder trees, large note bodies — simulate a year of heavy usage. Measure page list load, search, calendar render, and folder switch against real SQLite with realistic indexes and FTS. Could use the existing `pnpm seed` script as a starting point, run Tauri in dev mode, and profile with Playwright or manually.