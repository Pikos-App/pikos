# Test Strategy — Pikos

## Current state

**Vitest (unit)**:
- `packages/core/src/nlp/__tests__/parser.test.ts` — 40+ cases covering NLP parser (dates, tags, priority, recurrence, finite windows, duration, title cleanup). Good coverage.
- `apps/desktop/src/__tests__/WorkspaceContext.test.tsx` — 11 cases covering optimistic updates, debounce accumulation, rollback on error, flushPage, scheduleOnce, clearSchedule, mutation queue serialization, reorderPages, deletePage cancelling pending writes. 1 test skipped (concurrent update+schedule). Good coverage.

**Playwright (E2E)**: placeholder only (`e2e/placeholder.spec.ts` — `"app loads"` checks body is visible). Config exists at `apps/desktop/playwright.config.ts` pointing at chromium + `localhost:1420` with `VITE_TEST_MODE=true`.

**Pre-push hook**: `pnpm check && pnpm exec turbo test` (Vitest only, no Playwright).

---

## Testing philosophy

**Test user-visible behavior, not implementation details.** Every assertion should answer: "would a user notice if this broke?" Assert against visible text, elements appearing/disappearing, navigation changes, and user-facing state. Never assert against CSS classes, component props, internal state, DOM structure, or specific HTML tag names.

**For Vitest**: Test inputs and outputs of functions. Don't test that a function calls another function internally — test that given input X, the output is Y. Don't mock implementation internals; mock boundaries (storage adapters, Tauri IPC).

**For Playwright**: Use accessible selectors — `getByRole`, `getByText`, `getByPlaceholder`, `getByTestId` as a last resort. Never use fragile selectors like `.class-name > div:nth-child(3)`. If a test would break because you renamed a CSS class or refactored a component hierarchy without changing behavior, it's testing implementation details.

**Why this matters**: Claude Code will be writing these tests. Without this principle stated explicitly, it will default to asserting against internal structure. Every test should survive a complete UI refactor as long as the user-facing behavior stays the same.

---

## Vitest — unit/integration gaps

### Priority 1: High blast radius, pure logic

These are functions called from many places. A regression here silently corrupts data or breaks core flows.

| Module | File | What to test | Current coverage |
|--------|------|-------------|-----------------|
| **pageFilters** | `apps/desktop/src/features/pages/utils/pageFilters.ts` | `sortPages()` all 4 modes, `getVisiblePages()` (today/inbox/folder), `getCompletedTodayPages()`, `getCompletedViewPages()`, `groupTodayPages()` overdue vs today split (all-day vs timed boundary) | **None** |
| **calendarUtils** | `apps/desktop/src/features/calendar/calendarUtils.ts` | `isAllDayPage()`, `buildAllDayItems()`, `buildDayBlocks()` (overlap columns, compact blocks, sorting), `timeToY()` clamping, `yToDate()` snapping, `snapY()`, `formatTimeRange()` AM/PM sharing, `hexToRgba()` fallback | **None** |
| **extractText** | `packages/core/src/utils/extractText.ts` | Nested Tiptap JSON → plain text, empty/invalid input, string input, code blocks, task items | **None** |
| **MockStorageAdapter** | `packages/core/src/adapters/MockStorageAdapter.ts` | `_refreshDenorm()` correctness (denormalized scheduledStart on page matches next future schedule), `listPagesToday()` filter, `listPageSchedulesRange()` edge cases, `searchPages()` excerpt generation, `matchesFilter()` compound filters | **None** |

### Priority 2: Medium blast radius

| Module | File | What to test |
|--------|------|-------------|
| **NLP parser** | `packages/core/src/nlp/parser.ts` | Already good. Add: edge cases for `for` disambiguation with no recurrence pattern, `monthly` keyword, `every N weeks`, multi-tag ordering stability. |
| **WorkspaceContext** | `apps/desktop/src/__tests__/WorkspaceContext.test.tsx` | Fix the skipped concurrent update+schedule test. Add: `createFolder`/`deleteFolder` optimistic updates, `searchTags()` round-trip, event emitter (`on('page:created')`) fires. |
| **Keyboard registry** | `apps/desktop/src/shared/keyboard/registry.ts` | Scope push/pop ordering, chord timeout (400ms), `Mod` → platform-correct key, `when` conditional, `allowInInputs` flag, `repeat` suppression. Pure logic, no DOM needed. |

### Priority 3: Important but lower blast radius

| Module | File | What to test |
|--------|------|-------------|
| **useAutosave** | `apps/desktop/src/features/editor/hooks/useAutosave.ts` | Debounce fires after delay, flush() writes immediately, isDirty/isSaving transitions, error propagation. |
| **useLocalStorage** | `apps/desktop/src/shared/hooks/useLocalStorage.ts` | Serialize/deserialize, default value on missing key, updater function form. |
| **TauriSQLiteAdapter** | `apps/desktop/src/shared/adapters/TauriSQLiteAdapter.ts` | Out of scope for Vitest (requires Tauri IPC). Tested transitively via E2E on real binary, or manually. |

### Proposed test file locations

```
apps/desktop/src/features/pages/utils/pageFilters.test.ts
apps/desktop/src/features/calendar/calendarUtils.test.ts
packages/core/src/utils/extractText.test.ts
packages/core/src/adapters/MockStorageAdapter.test.ts
apps/desktop/src/shared/keyboard/registry.test.ts
apps/desktop/src/features/editor/hooks/useAutosave.test.ts
apps/desktop/src/shared/hooks/useLocalStorage.test.ts
```

### Specific test specs for Priority 1

**pageFilters.test.ts**:
```
sortPages — manual mode → sorted by sortOrder ascending
sortPages — date mode → scheduled first, unscheduled sink to bottom
sortPages — date mode, all-day today sorts at "now" (between overdue and future)
sortPages — title mode → alphabetical
sortPages — priority mode → urgent(1) before high(2) before ... none(0) last
sortPages — priority mode, same tier → sub-sorted by date ascending
getVisiblePages — "today" → scheduled <= today, excludes done
getVisiblePages — "today" → includes overdue from yesterday
getVisiblePages — "inbox" → folderId null, excludes done
getVisiblePages — folder ID → matches folderId, excludes done
groupTodayPages — all-day item today → in "today" group (not overdue)
groupTodayPages — all-day item yesterday → in "overdue" group
groupTodayPages — timed item 2 hours ago → in "overdue" group
groupTodayPages — timed item 2 hours from now → in "today" group
getCompletedTodayPages — only status=done with completedAt today
getCompletedViewPages — inbox → done + folderId null
```

**calendarUtils.test.ts**:
```
isAllDayPage — "2026-03-15" → true
isAllDayPage — "2026-03-15T14:00:00" → false
buildAllDayItems — returns only all-day pages matching the given day
buildDayBlocks — single timed event → correct top/height/column
buildDayBlocks — two overlapping events → 2 columns
buildDayBlocks — no-end event → isCompact=true, height=COMPACT_BLOCK_HEIGHT
buildDayBlocks — sub-15-min event → isCompact=true
buildDayBlocks — excludes all-day events
buildDayBlocks — empty input → []
timeToY — 6:00 AM → 0 (grid start)
timeToY — 5:00 AM → 0 (clamped)
timeToY — 11:00 PM → GRID_HEIGHT (clamped)
timeToY — 9:30 AM → (3.5 * HOUR_HEIGHT)
yToDate — 0px → 6:00 AM on given day
yToDate — snaps to 15-min boundaries
snapY — rounds to nearest 15-min grid line
formatTimeRange — same period → "9 – 10:30 AM"
formatTimeRange — cross period → "11:30 AM – 1 PM"
hexToRgba — valid hex → correct rgba string
hexToRgba — invalid hex → fallback indigo
```

**extractText.test.ts**:
```
empty string → ""
empty object "{}" string → ""
null/undefined → ""
simple paragraph → plain text
nested headings + paragraphs → newline-separated
code block → text extracted
task list items → text extracted
deeply nested lists → all text extracted
JSON string input → parsed and extracted
invalid JSON string → ""
```

---

## Playwright — E2E strategy

### Infrastructure changes needed

1. **Switch from Chromium to WebKit** — Tauri uses WebKit on macOS. Testing in Chromium masks rendering/API differences.
2. **`VITE_TEST_MODE=true`** — already set in `webServer.command`. App uses `MockStorageAdapter` (in-memory), no SQLite, no Tauri IPC. State resets on page reload.
3. **State reset between tests**: `await page.reload()` resets MockStorageAdapter (it lives in JS memory). No DB cleanup needed.

### Proposed playwright.config.ts

> **Important**: The existing config has a Chromium project. Remove it entirely. This config should be the *only* project definition — no Chromium, no Firefox. Tauri uses WebKit on macOS, so that's the only engine worth testing against.

```ts
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env["CI"],
  retries: process.env["CI"] ? 2 : 0,
  workers: process.env["CI"] ? 1 : undefined,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: "http://localhost:1420",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    timeout: 15_000,
  },
  expect: {
    timeout: 5_000,
  },
  projects: [
    {
      name: "tier1",
      use: { ...devices["Desktop Safari"] },
      grep: /@tier1/,
    },
    {
      name: "tier2",
      use: { ...devices["Desktop Safari"] },
      grep: /@tier2/,
    },
  ],
  webServer: {
    command: "VITE_TEST_MODE=true pnpm vite",
    url: "http://localhost:1420",
    reuseExistingServer: !process.env["CI"],
    timeout: 30_000,
  },
});
```

Per-test timeout is 15s, expect timeout is 5s. The pre-push gate targets <60s for ~8 tests, so a single hanging test can't block for the default 30s.

### Tier 1 — pre-push gate (~8 tests, < 60s)

These are the flows where failure = "app is broken." Every push must pass these.

#### T1-1: App boots to welcome screen
- Navigate to `/`
- Assert: "Get started" button visible (WelcomeScreen renders)
- Click "Get started"
- Assert: Three-panel layout visible (sidebar, page list, editor)

#### T1-2: Create page via Quick Add (Cmd+N)
- Boot app (click "Get started")
- Press `Cmd+N`
- Assert: Quick Add dialog visible, input focused
- Type `team meeting @tomorrow at 2pm #work`
- Assert: NLP chips render (date chip, tag chip)
- Press `Enter`
- Assert: Dialog closes, page appears in page list with title "team meeting"

#### T1-3: Open page and edit content
- Create a page via Quick Add
- Click the page in the page list
- Assert: Editor pane shows, title matches
- Click into the Tiptap editor area
- Type `Hello world`
- Assert: Editor content contains "Hello world"

#### T1-4: Complete a page (toggle status)
- Create a page
- Find the page in the list, click its status checkbox/toggle
- Assert: Page moves to completed section (or disappears from active list)

#### T1-5: Create and navigate folders
- Click "New Folder" in sidebar
- Assert: Folder appears in sidebar
- Click the folder
- Assert: Page list shows empty state for that folder
- Create a page (Cmd+N, assign to folder via `~FolderName`)
- Assert: Page appears in that folder's list

#### T1-6: Today view shows scheduled pages
- Create a page with `@today` via Quick Add
- Click "Today" in sidebar
- Assert: Page visible in Today view

#### T1-7: Delete a page
- Create a page
- Right-click (or use delete action) on the page
- Confirm deletion in dialog
- Assert: Page removed from list

#### T1-8: Toggle editor ↔ calendar and verify calendar content (Cmd+Shift+C)
- Boot app
- Create a page via Quick Add: `calendar test @today at 2pm for 1h`
- Assert: Editor panel visible
- Press `Cmd+Shift+C`
- Assert: Calendar panel visible (week grid renders)
- Assert: A time block for "calendar test" renders in the calendar grid at the 2 PM position (verify the block element exists with the page title, and its CSS `top` value corresponds to 2 PM in the grid — `(14 - GRID_START_HOUR) * HOUR_HEIGHT = 8 * 64 = 512px`)
- Press `Cmd+Shift+C` again
- Assert: Editor panel visible again

### Tier 2 — pre-release (run manually or in CI nightly)

#### T2-1: Quick Add batch mode (Cmd+Enter)
- Open Quick Add
- Type a page title, press `Cmd+Enter`
- Assert: Page created, dialog stays open, input cleared
- Type another page title, press `Enter`
- Assert: Second page created, dialog closes

#### T2-2: Quick Add with priority
- Quick Add: `important task !urgent`
- Assert: Page created with urgent priority indicator visible in list

#### T2-3: Folder drag-and-drop reorder
- Create 3 folders
- Drag folder 3 above folder 1
- Assert: New order persists after reload

#### T2-4: Page drag-and-drop reorder
- Create 3 pages in a folder
- Drag page 3 above page 1
- Assert: New order persists

#### T2-5: Search
- Create pages with distinct titles
- Open search (Cmd+K or search input)
- Type a fragment of one title
- Assert: Matching page appears in results
- Click result
- Assert: Page opens in editor

#### T2-6: Calendar week navigation
- Switch to calendar view
- Assert: Current week visible (today highlighted)
- Click "Next week" arrow
- Assert: Dates shift forward by 7 days

#### T2-7: Settings panel
- Open settings (Cmd+, or UI)
- Assert: Settings overlay renders with tabs
- Navigate between tabs
- Assert: Each tab content renders

#### T2-8: Page scheduling via calendar drag
- Create an unscheduled page
- Drag page from list onto a calendar time slot
- Assert: Page shows as a block in the calendar at that time
- Assert: Page shows scheduled time in the page list

#### T2-9: Inbox view
- Create a page with no folder assignment
- Click "Inbox" in sidebar
- Assert: Page visible in Inbox

#### T2-10: Tag management
- Create page with `#design #ux` via Quick Add
- Open the page
- Assert: Tags visible in metadata header
- Remove a tag
- Assert: Tag removed

---

## Test infrastructure

### Tauri API mocking for browser E2E

When running with `VITE_TEST_MODE=true`, `WorkspaceContext` already branches to `MockStorageAdapter` and never calls `invoke()`. The two remaining Tauri APIs used in the app:

1. **`@tauri-apps/api/core` — `invoke()`**: Not called in test mode (adapter switch handles it).
2. **`@tauri-apps/plugin-store`**: Used for persisting last workspace path. In test mode, either mock or let it throw — `selectWorkspace()` has a fallback.
3. **`@tauri-apps/api/event` — `listen()`**: Used for window close event. In browser, this is absent — needs a no-op stub.

The existing `src/test/setup.ts` handles this for Vitest. For Playwright, add a `e2e/global-setup.ts` or intercept via page.addInitScript if needed — but `VITE_TEST_MODE` compile-time flag should handle most cases. Verify during implementation.

### State reset

- **Vitest**: Each test renders a fresh `WorkspaceProvider` with a new `MockStorageAdapter` instance. No cleanup needed.
- **Playwright**: `page.reload()` between tests resets the in-memory adapter. The `app` fixture (see below) handles this automatically.

### Playwright environment setup/teardown

**beforeEach**: Every test calls `page.goto("/")` (which reloads the app and resets the in-memory MockStorageAdapter) then boots past the welcome screen. The `app` fixture handles both steps — no test inherits state from a previous test.

**afterEach**: Screenshots are captured on failure via the `screenshot: "only-on-failure"` config option. No custom afterEach needed — Playwright handles this automatically. Critical for debugging pre-push failures where you can't reproduce interactively.

**Global setup**: The `webServer` config starts the dev server and waits for it to respond. No additional `globalSetup` script is needed — Playwright already hits the URL and confirms it's reachable before running tests. If the server fails to start within 30s, the entire suite aborts.

**Global teardown**: Nothing needed. Playwright's `webServer` config kills the dev server process automatically when tests complete. Stated explicitly so future contributors don't add unnecessary cleanup scripts.

**Parallel safety**: `fullyParallel: true` is safe. MockStorageAdapter lives in JavaScript memory inside each browser context. Each Playwright worker gets its own browser context → its own app instance → its own adapter. Workers cannot interfere with each other. Do not disable parallelism "just to be safe" — it's already safe by construction.

**Test fixture pattern** (`e2e/fixtures.ts`):

Formalize `bootApp()` as a Playwright fixture so every test gets a booted app with clean state automatically:

```ts
import { test as base, expect } from "@playwright/test";
import type { Page } from "@playwright/test";

export const test = base.extend<{ app: Page }>({
  app: async ({ page }, use) => {
    await page.goto("/");
    await page.getByRole("button", { name: /get started/i }).click();
    await expect(page.locator("[data-testid=three-panel-layout]")).toBeVisible();
    await use(page);
  },
});

export { expect };
```

Tier 1 tests declare `test("... @tier1", async ({ app }) => { ... })` and get a booted app with clean state. The `quickAdd` helper lives alongside:

```ts
/** Create a page via Quick Add and wait for dialog to close. */
export async function quickAdd(page: Page, input: string) {
  await page.keyboard.press("Meta+n");
  await page.getByPlaceholder(/new page/i).fill(input);
  await page.keyboard.press("Enter");
  // Wait for dialog to close before continuing
  await expect(page.getByRole("dialog")).not.toBeVisible();
}
```

### Pre-push hook wiring

Current `.husky/pre-push`:
```sh
pnpm check
pnpm exec turbo test
```

Add Tier 1 E2E after unit tests with `-x` (bail on first failure) for fast feedback:
```sh
pnpm check
pnpm exec turbo test
pnpm --filter @pikos/desktop test:e2e -- --project tier1 -x
```

The `-x` flag (alias for `--bail`) stops on first failure. If a Tier 1 test fails, the remaining tests are skipped — no point waiting for 7 more tests when the app is broken.

Tag tests with `@tier1` / `@tier2` in their title. The Playwright config uses `grep` per project to filter:
```ts
test("create page via Quick Add @tier1", async ({ app }) => { ... });
```

Run Tier 2 separately (pre-release, not pre-push): `pnpm --filter @pikos/desktop test:e2e -- --project tier2`

### Test data helpers

Defined in `e2e/fixtures.ts` (see "Test fixture pattern" above). The `app` fixture replaces the standalone `bootApp()` function. Additional helpers (`quickAdd`, `createFolder`) are plain exported functions in the same file that take a `Page` argument.

---

## What NOT to test

| Area | Reason |
|------|--------|
| **Tauri native APIs** (fs, opener, window management) | Requires actual Tauri binary. Test manually on each release. Not reachable via browser E2E. |
| **TauriSQLiteAdapter** | Thin `invoke()` wrapper — zero logic. Bugs here are Tauri IPC bugs, not app bugs. Tested transitively when running the real Tauri app. |
| **Rust DB commands** (pages.rs, folders.rs, etc.) | Would need a separate Rust test harness with SQLite. Value is low — SQL queries are straightforward CRUD, and the MockStorageAdapter mirrors their behavior. Consider adding later if SQL bugs surface. |
| **Visual regression** | Deferred. Requires screenshot comparison tooling (Playwright has it, but baseline management is overhead). Revisit when UI stabilizes. |
| **CSS/Tailwind rendering** | Covered by visual QA. Layout bugs are caught faster by eyeballing than by pixel assertions. |
| **Third-party library internals** | Don't test that Tiptap renders bold text or that date-fns parses dates. Test *our* code that calls them. |
| **React component rendering** (pure layout components) | `Sidebar.tsx`, `ThreePanelLayout.tsx`, `TimeGutter.tsx` — these are layout glue. If they break, Tier 1 E2E catches it. No isolated unit tests needed. |
| **Performance benchmarks** | Deferred. Instrument later with Playwright `page.metrics()` or React Profiler when optimization becomes a priority. |

---

## Execution order

1. **pageFilters.test.ts** — highest value, zero coverage, 6 functions, pure logic, fast to write
2. **calendarUtils.test.ts** — zero coverage, complex overlap algorithm, many edge cases
3. **extractText.test.ts** — zero coverage, used for FTS (search breaks if this regresses)
4. **Playwright config update** — switch to WebKit (remove Chromium), add tier projects, timeouts, screenshot-on-failure, wire pre-push with `-x`
4b. **e2e/fixtures.ts** — implement the `app` fixture and `quickAdd` helper before writing any individual test. Every Tier 1 test depends on these.
5. **T1-1 through T1-8** — Tier 1 E2E tests
6. **keyboard registry.test.ts** — medium priority, pure logic
7. **Remaining Priority 2 Vitest** — WorkspaceContext gaps, parser edge cases
8. **Tier 2 E2E** — after Tier 1 is stable
