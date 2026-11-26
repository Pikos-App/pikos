// Native pickers and Tauri filesystem APIs aren't available in browser-only e2e, so the import surface honours
// VITE_TEST_MODE escape hatches: `window.__PIKOS_TEST_VAULT__` feeds prebuilt VaultFile entries to the markdown
// parser, and `window.__PIKOS_TEST_CSV__` feeds a raw CSV string to the CSV parser.

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

  // The global is read at click time, so order against opening Settings doesn't matter.
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

  await app.getByRole("button", { name: /Select Folder/ }).click();

  await expect(app.getByRole("heading", { name: "Import Preview" })).toBeVisible();
  await expect(app.getByText(/Markdown \/ Obsidian/)).toBeVisible();
  await expect(app.getByText(/4 pages in 2 folders \+ Inbox/)).toBeVisible();

  await app.getByRole("button", { name: /Import 4 pages/ }).click();

  // Escape dismisses settings: the auto-close doesn't reliably clear the overlay here, and the still-mounted
  // overlay intercepts sidebar clicks (toBeVisible doesn't check z-stacking).
  await expect(app.getByRole("heading", { name: "Import Preview" })).not.toBeVisible({
    timeout: 5_000,
  });
  await app.keyboard.press("Escape");
  await expect(app.getByRole("button", { exact: true, name: "Data" })).not.toBeVisible({
    timeout: 5_000,
  });

  await expect(app.locator("[data-page-list-item]").getByText("Inbox Note")).toBeVisible();

  const sidebar = app.getByRole("group", { name: "Views and folders" });
  await expect(sidebar.getByRole("button", { exact: true, name: "Work" })).toBeVisible();
  await expect(sidebar.getByRole("button", { exact: true, name: "Personal" })).toBeVisible();

  // Quarterly Report is done, so it sits under the collapsed Completed section; expand it first.
  await sidebar.getByRole("button", { exact: true, name: "Work" }).click();
  const workItems = app.locator("[data-page-list-item]");
  await expect(workItems.getByText("Followups")).toBeVisible();
  await app.getByRole("button", { name: /^Completed/ }).click();
  await expect(workItems.getByText("Quarterly Report")).toBeVisible();

  expect(errors).toEqual([]);
});

appTest("markdown import: cancel from preview returns to settings", async ({ app }) => {
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
  await app.getByRole("button", { name: /Select Folder/ }).click();

  await expect(app.getByRole("heading", { name: "Import Preview" })).toBeVisible();

  // Cancel via the back arrow returns to the Data tab, not out of settings.
  await app.getByRole("button", { name: "Cancel import" }).click();
  await expect(app.getByRole("heading", { name: "Import" })).toBeVisible();
  await expect(app.getByRole("heading", { name: "Import Preview" })).not.toBeVisible();

  await app.keyboard.press("Escape");
  await expect(app.locator("[data-page-list-item]").getByText("Inbox Note")).not.toBeVisible();
});

appTest("markdown import: empty vault shows error and skips preview", async ({ app }) => {
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
  await app.getByRole("button", { name: /Select Folder/ }).click();

  await expect(app.getByText(/No \.md files found/)).toBeVisible();
  await expect(app.getByRole("heading", { name: "Import Preview" })).not.toBeVisible();
});

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
    await app.getByRole("button", { name: /Select Folder/ }).click();
    await expect(app.getByRole("heading", { name: "Import Preview" })).toBeVisible();

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

    // The Completed accordion always renders its header, so assert it's empty rather than missing.
    await app.getByRole("button", { exact: true, name: "Completed" }).click();
    await expect(workItems.filter({ hasText: "Quarterly Report" })).toHaveCount(0);
  }
);

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
    await app.getByRole("button", { name: /Select Folder/ }).click();
    await expect(app.getByRole("heading", { name: "Import Preview" })).toBeVisible();

    await expect(app.getByText(/2 pages in 2 folders/)).toBeVisible();

    await expect(app.getByRole("button", { name: "Projects / Work (1)" })).toBeVisible();
    await expect(app.getByRole("button", { name: "Personal / Travel (1)" })).toBeVisible();
  }
);

// Unit tests cover each stage; this is the only place the whole chain is checked. Dropping `priority` or
// `scheduled` in importBatch would leave pages stripped of metadata while the pages still exist.

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

    await expect(app.getByRole("button", { name: "Priority: High" })).toBeVisible();
  }
);

const TICKTICK_CSV = `List Name,Title,Status
Work,Quarterly plan,0
Personal,Buy milk,0
Work,Old task,2`;

appTest("CSV import: TickTick autodetect → mapping → preview → commit", async ({ app }) => {
  await app.evaluate((csv) => {
    (window as unknown as Record<string, unknown>)["__PIKOS_TEST_CSV__"] = csv;
  }, TICKTICK_CSV);

  await app.getByRole("button", { name: "Open settings" }).click();
  await app.getByRole("button", { exact: true, name: "Data" }).click();
  await app.getByRole("button", { name: /Select File/ }).click();

  await expect(app.getByRole("heading", { name: "Map CSV Columns" })).toBeVisible();
  await expect(app.getByText(/Auto-detected as TickTick/)).toBeVisible();

  const continueBtn = app.getByRole("button", { name: "Continue" });
  await expect(continueBtn).toBeEnabled();
  await continueBtn.click();

  await expect(app.getByRole("heading", { name: "Import Preview" })).toBeVisible();
  await expect(app.getByRole("button", { name: /Import 3 pages/ })).toBeVisible();
  await app.getByRole("button", { name: /Import 3 pages/ }).click();
  await expect(app.getByRole("heading", { name: "Import Preview" })).not.toBeVisible({
    timeout: 5_000,
  });
  // The overlay can linger after import in this harness; Escape clears it.
  await app.keyboard.press("Escape");

  const sidebar = app.getByRole("group", { name: "Views and folders" });
  await expect(sidebar.getByRole("button", { exact: true, name: "Work" })).toBeVisible();
  await expect(sidebar.getByRole("button", { exact: true, name: "Personal" })).toBeVisible();

  await sidebar.getByRole("button", { exact: true, name: "Work" }).click();
  const workItems = app.locator("[data-page-list-item]");
  await expect(workItems.filter({ hasText: "Quarterly plan" })).toBeVisible();

  await app.getByRole("button", { exact: true, name: "Completed" }).click();
  await expect(workItems.filter({ hasText: "Old task" })).toBeVisible();
});

appTest("CSV import: cancel from mapping page returns to Data settings", async ({ app }) => {
  await app.evaluate((csv) => {
    (window as unknown as Record<string, unknown>)["__PIKOS_TEST_CSV__"] = csv;
  }, TICKTICK_CSV);

  await app.getByRole("button", { name: "Open settings" }).click();
  await app.getByRole("button", { exact: true, name: "Data" }).click();
  await app.getByRole("button", { name: /Select File/ }).click();
  await expect(app.getByRole("heading", { name: "Map CSV Columns" })).toBeVisible();

  // Exact match avoids the back arrow's "Cancel import" name.
  await app.getByRole("button", { exact: true, name: "Cancel" }).click();

  await expect(app.getByRole("heading", { name: "Import" })).toBeVisible();
  await expect(app.getByRole("heading", { name: "Map CSV Columns" })).not.toBeVisible();

  await app.keyboard.press("Escape");
  await expect(
    app.locator("[data-page-list-item]").filter({ hasText: "Quarterly plan" })
  ).not.toBeVisible();
});
