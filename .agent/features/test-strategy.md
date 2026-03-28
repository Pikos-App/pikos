# Test Strategy — Pikos

## Testing philosophy

**Test user-visible behavior, not implementation details.** Every assertion should answer: "would a user notice if this broke?" Assert against visible text, elements appearing/disappearing, navigation changes, and user-facing state. Never assert against CSS classes, component props, internal state, DOM structure, or specific HTML tag names.

**For Vitest**: Test inputs and outputs of functions. Don't test that a function calls another function internally — test that given input X, the output is Y. Don't mock implementation internals; mock boundaries (storage adapters, Tauri IPC).

**For Playwright**: Use accessible selectors — `getByRole`, `getByText`, `getByPlaceholder`. Never use `getByTestId`, CSS classes, or DOM structure selectors. If a test would break because you renamed a CSS class or refactored a component hierarchy without changing behavior, it's testing implementation details.

**Why this matters**: Claude Code will be writing these tests. Without this principle stated explicitly, it will default to asserting against internal structure. Every test should survive a complete UI refactor as long as the user-facing behavior stays the same.

---

## Vitest — unit/integration tests

### Implemented

Source of truth is the test files themselves. Summary of coverage:

| Module | File | Status |
|--------|------|--------|
| **NLP parser** | `packages/core/src/nlp/__tests__/parser.test.ts` | 40+ cases. Good coverage. |
| **WorkspaceContext** | `apps/desktop/src/__tests__/WorkspaceContext.test.tsx` | Optimistic updates, debounce, rollback, flush, schedules, mutations, reorder, delete, events. |
| **pageFilters** | `apps/desktop/src/features/pages/utils/pageFilters.test.ts` | Sort modes, visible/completed filtering, today grouping. |
| **calendarUtils** | `apps/desktop/src/features/calendar/calendarUtils.test.ts` | Block building, overlap columns, time↔Y conversion, formatting. |
| **extractText** | `packages/core/src/utils/extractText.test.ts` | Tiptap JSON → plain text, edge cases. |
| **MockStorageAdapter** | `packages/core/src/adapters/MockStorageAdapter.test.ts` | Denorm refresh, today filter, schedule ranges, search, compound filters. |
| **Keyboard registry** | `apps/desktop/src/shared/keyboard/registry.test.ts` | Scope push/pop, chords, Mod key, conditionals, input handling. |
| **useAutosave** | `apps/desktop/src/features/editor/hooks/useAutosave.test.ts` | Debounce, flush, dirty/saving transitions, errors. |
| **useLocalStorage** | `apps/desktop/src/shared/hooks/useLocalStorage.test.ts` | Serialize/deserialize, defaults, updater function. |
| **UIContext** | `apps/desktop/src/shared/context/UIContext.test.tsx` | Context state management. |
| **dates** | `apps/desktop/src/shared/utils/dates.test.ts` | Date utility functions. |

### Remaining gaps

| Module | What to test |
|--------|-------------|
| **NLP parser** | Edge cases: `for` disambiguation with no recurrence, `monthly` keyword, `every N weeks`, multi-tag ordering stability. |
| **WorkspaceContext** | Fix skipped concurrent update+schedule test. |
| **TauriSQLiteAdapter** | Out of scope for Vitest (requires Tauri IPC). Tested transitively via real Tauri app. |

---

## Playwright — E2E tests

### Infrastructure

**Source of truth:** `apps/desktop/playwright.config.ts`, `apps/desktop/e2e/fixtures.ts`

- **Engine**: WebKit (Desktop Safari) — Tauri uses WebKit on macOS
- **Test mode**: `VITE_TEST_MODE=true` → `MockStorageAdapter` (in-memory), no SQLite, no Tauri IPC
- **State reset**: Each test uses the `app` fixture which calls `page.goto("/")` + boots past welcome screen. MockStorageAdapter resets on page load.
- **Parallel safety**: `fullyParallel: true`. Each Playwright worker gets its own browser context → own app instance → own adapter. No interference.
- **Tier filtering**: `@tier1` / `@tier2` tags in test titles, matched by `grep` in Playwright config projects
- **Pre-push**: `.husky/pre-push` runs `pnpm check && pnpm exec turbo test`, then Tier 1 E2E with `-x` (bail on first failure) if Playwright browsers are installed

### Tier 1 — pre-push gate (11 tests)

**Source of truth:** `apps/desktop/e2e/tier1.spec.ts` + `apps/desktop/e2e/fixtures.ts`

Coverage: boot, Quick Add (all NLP chip types), page editing (title/description/body + autosave), status toggle + completed section, folder create/rename/isolation, Today view filtering, delete + undo, editor ↔ calendar toggle, search, move-to-folder, sidebar collapse/expand.

Selector strategy: roles, aria-labels, `aria-pressed`, `aria-current`, `data-active` — no CSS classes or `data-testid`. Accessibility attributes added to components as part of test implementation (SidebarListItem, SmartViewEntry, UndoToast, ThreePanelLayout).

### Tier 2 — pre-release (not yet implemented)

Run manually or in CI nightly. Tag tests with `@tier2`.

> **Covered by T1 (do not duplicate):**
> - Search (Cmd+P) → T1-9
> - Inbox view / folder isolation → T1-5
> - Priority NLP chip → T1-2 (`!high` assertion)
> - Folder rename and delete + orphan-to-Inbox → T1-5

#### T2-1: Quick Add batch mode (Cmd+Enter)
- Open Quick Add
- Type a page title, press `Cmd+Enter`
- Assert: Page created, dialog stays open, input cleared, success message visible
- Type another page title, press `Enter`
- Assert: Second page created, dialog closes
- Assert: Both pages visible in page list

#### T2-2: Quick Add folder assignment via chip
- Open Quick Add while viewing Inbox
- Click the folder chip, select a different folder from the popover
- Assert: Chip updates to show selected folder name
- Submit the page
- Assert: Page does NOT appear in Inbox
- Navigate to the selected folder — page is there
- Note: NLP `~folder` syntax is tested indirectly by T1-5's `quickAdd` helper

#### T2-3: Folder drag-and-drop reorder
- Create 3 folders (A, B, C)
- Drag folder C above folder A
- Assert: Sidebar shows C, A, B order
- Reload the page
- Assert: Order persists (C, A, B)

#### T2-4: Page drag-and-drop reorder
- Create 3 pages in a folder
- Drag page 3 above page 1
- Assert: New order reflected in page list
- Reload the page
- Assert: Order persists

#### T2-5: Calendar week navigation
- Toggle to calendar view (Cmd+Shift+C)
- Assert: Today column is highlighted
- Click "Next week" arrow
- Assert: Date headers shift forward by 7 days, today column no longer highlighted
- Click "Previous week" arrow
- Assert: Back to current week, today column highlighted again

#### T2-6: Calendar block rendering
- Create a page via Quick Add: `design review @today at 2pm for 1h`
- Toggle to calendar view
- Assert: A time block with title "design review" renders in the calendar grid
- Assert: Block is positioned at the 2 PM row (verify `top` CSS or visual position)
- Assert: Block spans 1 hour of height

#### T2-7: Page scheduling via calendar drag
- Create an unscheduled page
- Toggle to calendar view
- Drag the page from the page list onto a calendar time slot
- Assert: Page appears as a block at the dropped time
- Assert: Page shows scheduled time in the page list

#### T2-8: Settings panel navigation
- Open settings (Cmd+, or click Settings in sidebar)
- Assert: Settings overlay renders
- Navigate between tabs (General, Shortcuts, etc.)
- Assert: Each tab content renders without errors
- Close settings
- Assert: App returns to previous view

#### T2-9: Tag management
- Create page with `#design #ux` via Quick Add
- Open the page in editor
- Assert: Tags visible in metadata header
- Remove the `#ux` tag
- Assert: Only `#design` remains
- Navigate away and back
- Assert: Tag removal persisted

#### T2-10: Rich text editing
- Create a page and open in editor
- Type `# Heading` + Enter — assert heading renders
- Type `**bold text**` — assert bold formatting applied
- Type `- list item` + Enter — assert bullet list created
- Type `/` — assert slash command menu appears

#### T2-11: Overdue pages in Today view
- Create a page scheduled for yesterday via Quick Add
- Navigate to Today view
- Assert: Page appears in "Overdue" section (separate from "Today" section)
- Complete the overdue page
- Assert: Page moves to Completed section, leaves Overdue

---

## What NOT to test

| Area | Reason |
|------|--------|
| **Tauri native APIs** (fs, opener, window management) | Requires actual Tauri binary. Test manually on each release. Not reachable via browser E2E. |
| **TauriSQLiteAdapter** | Thin `invoke()` wrapper — zero logic. Bugs here are Tauri IPC bugs, not app bugs. |
| **Rust DB commands** (pages.rs, folders.rs, etc.) | Would need a separate Rust test harness. SQL queries are straightforward CRUD. Consider adding if SQL bugs surface. |
| **Visual regression** | Deferred. Revisit when UI stabilizes. |
| **CSS/Tailwind rendering** | Covered by visual QA. |
| **Third-party library internals** | Don't test that Tiptap renders bold or date-fns parses dates. Test *our* code that calls them. |
| **Pure layout components** | `Sidebar.tsx`, `ThreePanelLayout.tsx`, `TimeGutter.tsx` — layout glue. If they break, T1 E2E catches it. |
| **Performance benchmarks** | Deferred. Instrument later with Playwright `page.metrics()` or React Profiler. |
