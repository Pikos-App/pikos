// E2E coverage for the import flows (markdown vault + CSV).
//
// The native pickers and Tauri filesystem APIs aren't available in the
// browser-only e2e environment, so the import surface honours
// VITE_TEST_MODE-only escape hatches:
//   - `window.__PIKOS_TEST_VAULT__` feeds prebuilt VaultFile entries into the
//     markdown parser.
//   - `window.__PIKOS_TEST_CSV__` feeds a raw CSV string into the CSV parser.
// The rest of each flow — mapping page (CSV only), preview modal,
// executeImport, page list refresh — runs against the MockStorageAdapter
// exactly as it does in unit tests, so this spec verifies that the
// user-visible glue between the parsers and the workspace state is wired up.

import { expect } from "@playwright/test";

import { test as appTest } from "./fixtures";

const VAULT_PATH = "/tmp/pikos-e2e-vault";

const VAULT_FILES = [
  {
    path: "Inbox Note.md",
    content: `---\ntags: [quick]\n---\nA root-level capture.`,
  },
  {
    path: "Work/Quarterly Report.md",
    content: `---\nstatus: done\npriority: 2\ntags:\n  - work\n---\n# Q2 Report\n\nCovers all departments.`,
  },
  {
    path: "Work/Followups.md",
    content: `---\npriority: high\nscheduled: 2026-06-15\n---\nRing the supplier.`,
  },
  {
    path: "Personal/Reading List.md",
    content: `---\ntags: [books]\n---\n- The Idiot\n- Stoner`,
  },
];

appTest("markdown import: folder pick → preview → commit @tier2", async ({ app }) => {
  const errors: string[] = [];
  app.on("pageerror", (e) => errors.push(e.message));

  // Inject the test vault before any user interaction so the click handler
  // sees it. Settings has to be open first or the import button isn't mounted,
  // but the global is read at click time so order doesn't matter.
  await app.evaluate(
    ({ path, files }) => {
      (window as unknown as Record<string, unknown>)["__PIKOS_TEST_VAULT__"] = {
        files,
        path,
      };
    },
    { files: VAULT_FILES, path: VAULT_PATH }
  );

  await app.getByRole("button", { name: "Open settings" }).click();
  await app.getByRole("button", { name: "Data", exact: true }).click();
  await expect(app.getByRole("heading", { name: "Import" })).toBeVisible();

  // Trigger the markdown import. Without the test-mode escape hatch this
  // would call openDialog(); with it, the parser receives VAULT_FILES.
  await app.getByRole("button", { name: /Select Folder/ }).click();

  // Preview modal renders with a summary line. The source label is
  // "Markdown / Obsidian" and the page/folder counts come straight from the
  // parsed plan — 4 pages in 2 folders (Work × 2, Personal × 1) plus one
  // inbox page.
  await expect(app.getByRole("heading", { name: "Import Preview" })).toBeVisible();
  await expect(app.getByText(/Markdown \/ Obsidian/)).toBeVisible();
  await expect(app.getByText(/4 pages in 2 folders \+ Inbox/)).toBeVisible();

  await app.getByRole("button", { name: /Import 4 pages/ }).click();

  // After executeImport completes the SettingsPage effect SHOULD close the
  // overlay and route to inbox, but in this test environment the auto-close
  // doesn't reliably reach the click-handling layer before the next click
  // attempt — sidebar clicks get intercepted by the still-mounted settings
  // overlay (Playwright's toBeVisible doesn't check z-stacking). Escape
  // explicitly dismisses settings so subsequent sidebar clicks land. (Real
  // users hit Escape too if the auto-close ever lags.)
  await expect(app.getByRole("heading", { name: "Import Preview" })).not.toBeVisible({
    timeout: 5_000,
  });
  await app.keyboard.press("Escape");
  await expect(app.getByRole("button", { name: "Data", exact: true })).not.toBeVisible({
    timeout: 5_000,
  });

  await expect(app.locator("[data-page-list-item]").getByText("Inbox Note")).toBeVisible();

  // Folder sidebar should now have Work and Personal entries created by the
  // import. The exact-match filter avoids picking up "Work in progress" if
  // an unrelated test artifact ever lands in a default workspace.
  const sidebar = app.getByRole("group", { name: "Views and folders" });
  await expect(sidebar.getByRole("button", { name: "Work", exact: true })).toBeVisible();
  await expect(sidebar.getByRole("button", { name: "Personal", exact: true })).toBeVisible();

  // Open Work and verify its two pages landed there. Quarterly Report has
  // status=done so it's under the collapsed-by-default Completed section —
  // expand it before asserting.
  await sidebar.getByRole("button", { name: "Work", exact: true }).click();
  const workItems = app.locator("[data-page-list-item]");
  await expect(workItems.getByText("Followups")).toBeVisible();
  await app.getByRole("button", { name: /^Completed/ }).click();
  await expect(workItems.getByText("Quarterly Report")).toBeVisible();

  expect(errors).toEqual([]);
});

appTest("markdown import: cancel from preview returns to settings @tier2", async ({ app }) => {
  await app.evaluate(
    ({ path, files }) => {
      (window as unknown as Record<string, unknown>)["__PIKOS_TEST_VAULT__"] = {
        files,
        path,
      };
    },
    { files: VAULT_FILES.slice(0, 1), path: VAULT_PATH }
  );

  await app.getByRole("button", { name: "Open settings" }).click();
  await app.getByRole("button", { name: "Data", exact: true }).click();
  await app.getByRole("button", { name: /Select Folder/ }).click();

  await expect(app.getByRole("heading", { name: "Import Preview" })).toBeVisible();

  // Cancel via the back arrow returns to the Data settings tab, not all the
  // way out of settings. The Data tab's Import heading is the proof.
  await app.getByRole("button", { name: "Cancel import" }).click();
  await expect(app.getByRole("heading", { name: "Import" })).toBeVisible();
  await expect(app.getByRole("heading", { name: "Import Preview" })).not.toBeVisible();

  // No pages should have been created.
  await app.keyboard.press("Escape");
  await expect(app.locator("[data-page-list-item]").getByText("Inbox Note")).not.toBeVisible();
});

// ─── Empty vault ────────────────────────────────────────────────────────────
//
// Picking a folder with zero .md files is a user-visible negative path: the
// importer should refuse with a clear message rather than open an empty
// preview. Guards against a regression where the empty-file guard in
// parseMarkdownDir is dropped and the user lands on a preview with nothing
// to import (or worse, a crash on the empty plan).

appTest("markdown import: empty vault shows error and skips preview @tier2", async ({ app }) => {
  await app.evaluate(
    ({ path }) => {
      (window as unknown as Record<string, unknown>)["__PIKOS_TEST_VAULT__"] = {
        files: [],
        path,
      };
    },
    { path: VAULT_PATH }
  );

  await app.getByRole("button", { name: "Open settings" }).click();
  await app.getByRole("button", { name: "Data", exact: true }).click();
  await app.getByRole("button", { name: /Select Folder/ }).click();

  await expect(app.getByText(/No \.md files found/)).toBeVisible();
  await expect(app.getByRole("heading", { name: "Import Preview" })).not.toBeVisible();
});

// ─── Skip-completed toggle in preview ──────────────────────────────────────
//
// The preview modal exposes a "Skip N completed" checkbox when the plan
// contains any done pages. Toggling it filters the visible plan and updates
// the footer's "Import N pages" button. Confirming with the toggle on
// imports only the active subset. Regression here would silently let
// already-done pages flood the workspace on import.

appTest(
  "markdown import: skip-completed toggle drops done pages from the import @tier2",
  async ({ app }) => {
    await app.evaluate(
      ({ path, files }) => {
        (window as unknown as Record<string, unknown>)["__PIKOS_TEST_VAULT__"] = {
          files,
          path,
        };
      },
      { files: VAULT_FILES, path: VAULT_PATH }
    );

    await app.getByRole("button", { name: "Open settings" }).click();
    await app.getByRole("button", { name: "Data", exact: true }).click();
    await app.getByRole("button", { name: /Select Folder/ }).click();
    await expect(app.getByRole("heading", { name: "Import Preview" })).toBeVisible();

    // Plan has 1 completed page (Quarterly Report, status: done) of 4 total.
    // Confirm button reflects the full count until the toggle flips.
    await expect(app.getByRole("button", { name: /Import 4 pages/ })).toBeVisible();

    await app.getByRole("checkbox", { name: /Skip 1 completed/ }).check();

    // Footer count drops to the active subset (4 − 1 = 3).
    await expect(app.getByRole("button", { name: /Import 3 pages/ })).toBeVisible();
    await expect(app.getByRole("button", { name: /Import 4 pages/ })).not.toBeVisible();

    await app.getByRole("button", { name: /Import 3 pages/ }).click();
    await expect(app.getByRole("heading", { name: "Import Preview" })).not.toBeVisible({
      timeout: 5_000,
    });
    await app.keyboard.press("Escape");

    const sidebar = app.getByRole("group", { name: "Views and folders" });
    await sidebar.getByRole("button", { name: "Work", exact: true }).click();
    const workItems = app.locator("[data-page-list-item]");
    await expect(workItems.filter({ hasText: "Followups" })).toBeVisible();

    // The Completed accordion always renders as a header — expand it and
    // assert the section is empty rather than asserting the header is
    // missing. Quarterly Report was the only completed page in the source.
    await app.getByRole("button", { name: "Completed", exact: true }).click();
    await expect(workItems.filter({ hasText: "Quarterly Report" })).toHaveCount(0);
  }
);

// ─── Nested folders flatten to display names ───────────────────────────────
//
// Pikos has flat folders (no nesting) — nested vault paths flatten with " / "
// separators so the source structure is still visible to the user. This test
// locks down the preview-side display so a regression in
// parseMarkdownVault's path-join logic would surface immediately.

appTest(
  "markdown import: nested vault paths flatten to 'A / B' in the preview @tier2",
  async ({ app }) => {
    await app.evaluate(
      ({ path }) => {
        (window as unknown as Record<string, unknown>)["__PIKOS_TEST_VAULT__"] = {
          files: [
            { content: "Quarterly planning notes.", path: "Projects/Work/Q3 plan.md" },
            { content: "Holiday packing list.", path: "Personal/Travel/Iceland.md" },
          ],
          path,
        };
      },
      { path: VAULT_PATH }
    );

    await app.getByRole("button", { name: "Open settings" }).click();
    await app.getByRole("button", { name: "Data", exact: true }).click();
    await app.getByRole("button", { name: /Select Folder/ }).click();
    await expect(app.getByRole("heading", { name: "Import Preview" })).toBeVisible();

    await expect(app.getByText(/2 pages in 2 folders/)).toBeVisible();

    // Flattened folder labels surface as clickable folder rows in the preview tree.
    // The exact-name match avoids picking up unrelated text containing the substrings.
    await expect(
      app.getByRole("button", { name: "Projects / Work (1)" })
    ).toBeVisible();
    await expect(
      app.getByRole("button", { name: "Personal / Travel (1)" })
    ).toBeVisible();
  }
);

// ─── Frontmatter metadata round-trips to the page byline ────────────────────
//
// Verifies the full chain: YAML frontmatter → markdown parser → importBatch
// → workspace → page-list active state → editor byline chips. Unit tests
// cover each stage in isolation; this is the only place we assert the
// glue holds together. A regression that drops `priority` or `scheduled`
// during importBatch would silently leave imported pages stripped of
// metadata — silent because the page itself still exists.

appTest(
  "markdown import: frontmatter priority and schedule surface on the imported page byline @tier2",
  async ({ app }) => {
    await app.evaluate(
      ({ path }) => {
        (window as unknown as Record<string, unknown>)["__PIKOS_TEST_VAULT__"] = {
          files: [
            {
              content: `---\npriority: high\nscheduled: 2026-06-15\n---\nFollow up with the supplier.`,
              path: "Followup.md",
            },
          ],
          path,
        };
      },
      { path: VAULT_PATH }
    );

    await app.getByRole("button", { name: "Open settings" }).click();
    await app.getByRole("button", { name: "Data", exact: true }).click();
    await app.getByRole("button", { name: /Select Folder/ }).click();
    await expect(app.getByRole("heading", { name: "Import Preview" })).toBeVisible();
    await app.getByRole("button", { name: /Import 1 page/ }).click();
    await expect(app.getByRole("heading", { name: "Import Preview" })).not.toBeVisible({
      timeout: 5_000,
    });
    await app.keyboard.press("Escape");

    await app.locator("[data-page-list-item]").filter({ hasText: "Followup" }).click();

    await expect(app.getByRole("button", { name: /^Scheduled:/ })).toBeVisible();
    await expect(app.getByRole("button", { name: "Set schedule" })).not.toBeVisible();

    // Priority chip carries the "Priority: High" aria-label (priority: high → 2 → "High").
    await expect(app.getByRole("button", { name: "Priority: High" })).toBeVisible();
  }
);

// ─── CSV import: TickTick autodetect → mapping → preview → commit ───────────
//
// TickTick is the primary CSV migration target (the README ships with a
// dedicated migration guide). Detection keys on a "List Name" + "Title"
// header pair, which routes through the column-mapping page before the
// preview. A regression in autodetect, applyMappings, or the import-batch
// glue would silently strip migrated TickTick data.

const TICKTICK_CSV = `List Name,Title,Status
Work,Quarterly plan,0
Personal,Buy milk,0
Work,Old task,2`;

appTest(
  "CSV import: TickTick autodetect → mapping → preview → commit @tier2",
  async ({ app }) => {
    await app.evaluate((csv) => {
      (window as unknown as Record<string, unknown>)["__PIKOS_TEST_CSV__"] = csv;
    }, TICKTICK_CSV);

    await app.getByRole("button", { name: "Open settings" }).click();
    await app.getByRole("button", { name: "Data", exact: true }).click();
    await app.getByRole("button", { name: /Select File/ }).click();

    await expect(app.getByRole("heading", { name: "Map CSV Columns" })).toBeVisible();
    await expect(app.getByText(/Auto-detected as TickTick/)).toBeVisible();

    // Continue button is enabled because the autodetect already mapped a Title column.
    const continueBtn = app.getByRole("button", { name: "Continue" });
    await expect(continueBtn).toBeEnabled();
    await continueBtn.click();

    await expect(app.getByRole("heading", { name: "Import Preview" })).toBeVisible();
    await expect(app.getByRole("button", { name: /Import 3 pages/ })).toBeVisible();
    await app.getByRole("button", { name: /Import 3 pages/ }).click();
    await expect(app.getByRole("heading", { name: "Import Preview" })).not.toBeVisible({
      timeout: 5_000,
    });
    // SettingsPage auto-routes to inbox + closes on import success, but the
    // overlay sometimes lingers in this harness — Escape guarantees the
    // sidebar is clickable.
    await app.keyboard.press("Escape");

    const sidebar = app.getByRole("group", { name: "Views and folders" });
    await expect(sidebar.getByRole("button", { name: "Work", exact: true })).toBeVisible();
    await expect(sidebar.getByRole("button", { name: "Personal", exact: true })).toBeVisible();

    await sidebar.getByRole("button", { name: "Work", exact: true }).click();
    const workItems = app.locator("[data-page-list-item]");
    await expect(workItems.filter({ hasText: "Quarterly plan" })).toBeVisible();

    // Old task has TickTick Status=2 → mapped to "done", lives under the
    // Completed accordion in the same folder.
    await app.getByRole("button", { name: "Completed", exact: true }).click();
    await expect(workItems.filter({ hasText: "Old task" })).toBeVisible();
  }
);

// ─── CSV import: cancel from the mapping page ──────────────────────────────
//
// The mapping page sits between the file pick and the preview. Cancelling
// here must return to the Data settings tab without writing anything to the
// workspace. A regression in the reset wiring would either leave the user
// stranded on the mapping page or silently commit a partial plan.

appTest("CSV import: cancel from mapping page returns to Data settings @tier2", async ({ app }) => {
  await app.evaluate((csv) => {
    (window as unknown as Record<string, unknown>)["__PIKOS_TEST_CSV__"] = csv;
  }, TICKTICK_CSV);

  await app.getByRole("button", { name: "Open settings" }).click();
  await app.getByRole("button", { name: "Data", exact: true }).click();
  await app.getByRole("button", { name: /Select File/ }).click();
  await expect(app.getByRole("heading", { name: "Map CSV Columns" })).toBeVisible();

  // Footer Cancel button (exact match avoids the back-arrow's "Cancel import" name).
  await app.getByRole("button", { name: "Cancel", exact: true }).click();

  // Back to the Data tab — Import heading proves it; mapping page is gone.
  await expect(app.getByRole("heading", { name: "Import" })).toBeVisible();
  await expect(app.getByRole("heading", { name: "Map CSV Columns" })).not.toBeVisible();

  // No pages should have been created.
  await app.keyboard.press("Escape");
  await expect(
    app.locator("[data-page-list-item]").filter({ hasText: "Quarterly plan" })
  ).not.toBeVisible();
});
