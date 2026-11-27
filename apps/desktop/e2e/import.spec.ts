// The native pickers and Tauri filesystem APIs aren't available in the browser-only e2e environment, so the
// import surface honours two VITE_TEST_MODE-only escape hatches: `window.__PIKOS_TEST_VAULT__` feeds prebuilt
// VaultFile entries into the markdown parser, and `window.__PIKOS_TEST_CSV__` feeds a raw CSV string into the
// CSV parser. The rest of each flow runs against MockStorageAdapter, as in unit tests.

import { expect } from "@playwright/test";

import { test as appTest } from "./fixtures";

const VAULT_PATH = "/tmp/pikos-e2e-vault";

const VAULT_FILES = [
  {
    content: `---\ntags: [quick]\n---\nA root-level capture.`,
    path: "Inbox Note.md",
  },
  {
    content: `---\nstatus: done\npriority: 2\ntags:\n  - work\n---\n# Q2 Report\n\nCovers all departments.`,
    path: "Work/Quarterly Report.md",
  },
  {
    content: `---\npriority: high\nscheduled: 2026-06-15\n---\nRing the supplier.`,
    path: "Work/Followups.md",
  },
  {
    content: `---\ntags: [books]\n---\n- The Idiot\n- Stoner`,
    path: "Personal/Reading List.md",
  },
];

appTest("markdown import: folder pick → preview → commit", async ({ app }) => {
  const errors: string[] = [];
  app.on("pageerror", (e) => errors.push(e.message));

  // The global is read at click time, so only the settings overlay (which mounts the import button) must be open first.
  await app.evaluate(
    ({ files, path }) => {
      (window as unknown as Record<string, unknown>)["__PIKOS_TEST_VAULT__"] = {
        files,
        path,
      };
    },
    { files: VAULT_FILES, path: VAULT_PATH }
  );

  await app.getByRole("button", { name: "Open settings" }).click();
  await app.getByRole("button", { exact: true, name: "Data" }).click();
  await expect(app.getByRole("heading", { name: "Import" })).toBeVisible();

  await app.getByRole("button", { name: /Select folder/ }).click();

  // The source label is "Markdown / Obsidian"; counts come from the parsed plan: 4 pages in 2 folders
  // (Work × 2, Personal × 1) plus one inbox page.
  await expect(app.getByRole("heading", { name: "Import Preview" })).toBeVisible();
  await expect(app.getByText(/Markdown \/ Obsidian/)).toBeVisible();
  await expect(app.getByText(/4 pages in 2 folders \+ Inbox/)).toBeVisible();

  await app.getByRole("button", { name: /Import 4 pages/ }).click();

  // executeImport should close the overlay and route to inbox, but the auto-close doesn't reliably land before
  // the next click, and Playwright's toBeVisible doesn't check z-stacking, so the lingering overlay intercepts
  // sidebar clicks. Escape dismisses it explicitly.
  await expect(app.getByRole("heading", { name: "Import Preview" })).not.toBeVisible({
    timeout: 5_000,
  });
  await app.keyboard.press("Escape");
  await expect(app.getByRole("button", { exact: true, name: "Data" })).not.toBeVisible({
    timeout: 5_000,
  });

  await expect(app.locator("[data-page-list-item]").getByText("Inbox Note")).toBeVisible();

  // Exact match, so an unrelated "Work in progress" in a default workspace isn't picked up.
  const sidebar = app.getByRole("group", { name: "Views and folders" });
  await expect(sidebar.getByRole("button", { exact: true, name: "Work" })).toBeVisible();
  await expect(sidebar.getByRole("button", { exact: true, name: "Personal" })).toBeVisible();

  // Quarterly Report is status=done, so it sits under the collapsed Completed section; expand it before asserting.
  await sidebar.getByRole("button", { exact: true, name: "Work" }).click();
  const workItems = app.locator("[data-page-list-item]");
  await expect(workItems.getByText("Followups")).toBeVisible();
  await app.getByRole("button", { name: /^Completed/ }).click();
  await expect(workItems.getByText("Quarterly Report")).toBeVisible();

  expect(errors).toEqual([]);
});

appTest(
  "markdown import: cancel from preview returns to settings",
  async ({ app }) => {
    await app.evaluate(
      ({ files, path }) => {
        (window as unknown as Record<string, unknown>)["__PIKOS_TEST_VAULT__"] = {
          files,
          path,
        };
      },
      { files: VAULT_FILES.slice(0, 1), path: VAULT_PATH }
    );

    await app.getByRole("button", { name: "Open settings" }).click();
    await app.getByRole("button", { exact: true, name: "Data" }).click();
    await app.getByRole("button", { name: /Select folder/ }).click();

    await expect(app.getByRole("heading", { name: "Import Preview" })).toBeVisible();

    // Cancel via the back arrow returns to the Data settings tab, not out of settings; the Import heading proves it.
    await app.getByRole("button", { name: "Cancel import" }).click();
    await expect(app.getByRole("heading", { name: "Import" })).toBeVisible();
    await expect(app.getByRole("heading", { name: "Import Preview" })).not.toBeVisible();

    await app.keyboard.press("Escape");
    await expect(app.locator("[data-page-list-item]").getByText("Inbox Note")).not.toBeVisible();
  }
);

// Picking a folder with zero .md files must be refused with a clear message, not open an empty preview.
// Guards the empty-file guard in parseMarkdownDir; a crash on the empty plan is the worst case.

appTest(
  "markdown import: empty vault shows error and skips preview",
  async ({ app }) => {
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
    await app.getByRole("button", { exact: true, name: "Data" }).click();
    await app.getByRole("button", { name: /Select folder/ }).click();

    await expect(app.getByText(/No \.md files found/)).toBeVisible();
    await expect(app.getByRole("heading", { name: "Import Preview" })).not.toBeVisible();
  }
);

// The preview's "Skip N completed" checkbox filters the plan and the "Import N pages" button; confirming with it
// on imports only the active subset, so already-done pages don't flood the workspace.

appTest(
  "markdown import: skip-completed toggle drops done pages from the import",
  async ({ app }) => {
    await app.evaluate(
      ({ files, path }) => {
        (window as unknown as Record<string, unknown>)["__PIKOS_TEST_VAULT__"] = {
          files,
          path,
        };
      },
      { files: VAULT_FILES, path: VAULT_PATH }
    );

    await app.getByRole("button", { name: "Open settings" }).click();
    await app.getByRole("button", { exact: true, name: "Data" }).click();
    await app.getByRole("button", { name: /Select folder/ }).click();
    await expect(app.getByRole("heading", { name: "Import Preview" })).toBeVisible();

    // The plan has 1 completed page (Quarterly Report) of 4; the button shows the full count until the toggle flips.
    await expect(app.getByRole("button", { name: /Import 4 pages/ })).toBeVisible();

    await app.getByRole("checkbox", { name: /Skip 1 completed/ }).check();

    await expect(app.getByRole("button", { name: /Import 3 pages/ })).toBeVisible();
    await expect(app.getByRole("button", { name: /Import 4 pages/ })).not.toBeVisible();

    await app.getByRole("button", { name: /Import 3 pages/ }).click();
    await expect(app.getByRole("heading", { name: "Import Preview" })).not.toBeVisible({
      timeout: 5_000,
    });
    await app.keyboard.press("Escape");

    const sidebar = app.getByRole("group", { name: "Views and folders" });
    await sidebar.getByRole("button", { exact: true, name: "Work" }).click();
    const workItems = app.locator("[data-page-list-item]");
    await expect(workItems.filter({ hasText: "Followups" })).toBeVisible();

    // The Completed accordion always renders a header: expand it and assert it is empty, rather than asserting the header is missing.
    await app.getByRole("button", { exact: true, name: "Completed" }).click();
    await expect(workItems.filter({ hasText: "Quarterly Report" })).toHaveCount(0);
  }
);

// Pikos has flat folders, so nested vault paths flatten with " / " separators. Locks down the preview-side
// display against a regression in parseMarkdownVault's path-join.

appTest(
  "markdown import: nested vault paths flatten to 'A / B' in the preview",
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
    await app.getByRole("button", { exact: true, name: "Data" }).click();
    await app.getByRole("button", { name: /Select folder/ }).click();
    await expect(app.getByRole("heading", { name: "Import Preview" })).toBeVisible();

    await expect(app.getByText(/2 pages in 2 folders/)).toBeVisible();

    // Exact-name match avoids unrelated text containing the substrings.
    await expect(app.getByRole("button", { name: "Projects / Work (1)" })).toBeVisible();
    await expect(app.getByRole("button", { name: "Personal / Travel (1)" })).toBeVisible();
  }
);

// The full chain: YAML frontmatter → markdown parser → importBatch → workspace → page-list → editor byline
// chips. Unit tests cover each stage; this is the only check that the glue holds. A dropped `priority` or
// `scheduled` would leave imported pages silently stripped of metadata.

appTest(
  "markdown import: frontmatter priority and schedule surface on the imported page byline",
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
    await app.getByRole("button", { exact: true, name: "Data" }).click();
    await app.getByRole("button", { name: /Select folder/ }).click();
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

// TickTick is the primary CSV migration target. Detection keys on a "List Name" + "Title" header pair and
// routes through the column-mapping page before the preview; a regression in autodetect, applyMappings or the
// import-batch glue would silently strip migrated data.

const TICKTICK_CSV = `List Name,Title,Status
Work,Quarterly plan,0
Personal,Buy milk,0
Work,Old task,2`;

appTest(
  "CSV import: TickTick autodetect → mapping → preview → commit",
  async ({ app }) => {
    await app.evaluate((csv) => {
      (window as unknown as Record<string, unknown>)["__PIKOS_TEST_CSV__"] = csv;
    }, TICKTICK_CSV);

    await app.getByRole("button", { name: "Open settings" }).click();
    await app.getByRole("button", { exact: true, name: "Data" }).click();
    await app.getByRole("button", { name: /Select file/ }).click();

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
    // The overlay sometimes lingers in this harness after the import auto-closes it; Escape makes the sidebar clickable.
    await app.keyboard.press("Escape");

    const sidebar = app.getByRole("group", { name: "Views and folders" });
    await expect(sidebar.getByRole("button", { exact: true, name: "Work" })).toBeVisible();
    await expect(sidebar.getByRole("button", { exact: true, name: "Personal" })).toBeVisible();

    await sidebar.getByRole("button", { exact: true, name: "Work" }).click();
    const workItems = app.locator("[data-page-list-item]");
    await expect(workItems.filter({ hasText: "Quarterly plan" })).toBeVisible();

    // The old task (TickTick Status=2) maps to "done" and lives under the Completed accordion in its folder.
    await app.getByRole("button", { exact: true, name: "Completed" }).click();
    await expect(workItems.filter({ hasText: "Old task" })).toBeVisible();
  }
);

// The mapping page sits between the file pick and the preview; cancelling must return to the Data tab without
// writing to the workspace. A reset regression would strand the user or commit a partial plan.

appTest(
  "CSV import: cancel from mapping page returns to Data settings",
  async ({ app }) => {
    await app.evaluate((csv) => {
      (window as unknown as Record<string, unknown>)["__PIKOS_TEST_CSV__"] = csv;
    }, TICKTICK_CSV);

    await app.getByRole("button", { name: "Open settings" }).click();
    await app.getByRole("button", { exact: true, name: "Data" }).click();
    await app.getByRole("button", { name: /Select file/ }).click();
    await expect(app.getByRole("heading", { name: "Map CSV Columns" })).toBeVisible();

    // Footer Cancel button (exact match avoids the back-arrow's "Cancel import" name).
    await app.getByRole("button", { exact: true, name: "Cancel" }).click();

    await expect(app.getByRole("heading", { name: "Import" })).toBeVisible();
    await expect(app.getByRole("heading", { name: "Map CSV Columns" })).not.toBeVisible();

    await app.keyboard.press("Escape");
    await expect(
      app.locator("[data-page-list-item]").filter({ hasText: "Quarterly plan" })
    ).not.toBeVisible();
  }
);
