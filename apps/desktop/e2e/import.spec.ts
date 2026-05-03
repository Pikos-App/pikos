// E2E coverage for the markdown vault import flow.
//
// The native folder picker and Tauri filesystem APIs aren't available in the
// browser-only e2e environment, so the import surface honours
// VITE_TEST_MODE-only escape hatches: setting `window.__PIKOS_TEST_VAULT__`
// bypasses the dialog and feeds prebuilt VaultFile entries straight into the
// parser. The rest of the flow — preview modal, executeImport, page list
// refresh — runs against the MockStorageAdapter exactly as it does in unit
// tests, so this spec verifies that the user-visible glue between the parser
// and the workspace state is wired up.

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

  // Open settings and navigate to the Data tab where Import lives.
  await app.getByRole("button", { name: "Open settings" }).click();
  await app.getByRole("button", { name: "Data", exact: true }).click();
  await expect(app.getByRole("heading", { name: "Import" })).toBeVisible();

  // Trigger the markdown import. Without the test-mode escape hatch this
  // would call openDialog(); with it, the parser receives VAULT_FILES.
  await app.getByRole("button", { name: /Select Folder/ }).click();

  // Preview modal renders with a summary line. The source label is
  // "Markdown / Obsidian" and the page/folder counts come straight from the
  // parsed plan — 4 pages across 3 folders (Work × 2 + Personal × 1) plus
  // one inbox page.
  await expect(app.getByRole("heading", { name: "Import Preview" })).toBeVisible();
  await expect(app.getByText(/Markdown \/ Obsidian/)).toBeVisible();
  await expect(app.getByText(/4 pages in 2 folders \+ Inbox/)).toBeVisible();

  // Confirm the import. The button label reflects the visible count.
  await app.getByRole("button", { name: /Import 4 pages/ }).click();

  // After executeImport completes the SettingsPage effect closes the overlay
  // and routes to inbox. The imported pages appear in the page list — the
  // inbox-level note is in the active view, plus any folders show in the
  // sidebar.
  await expect(app.getByRole("heading", { name: "Import Preview" })).not.toBeVisible({
    timeout: 5_000,
  });

  await expect(app.locator("[data-page-list-item]").getByText("Inbox Note")).toBeVisible();

  // Folder sidebar should now have Work and Personal entries created by the
  // import. The exact-match filter avoids picking up "Work in progress" if
  // an unrelated test artifact ever lands in a default workspace.
  const sidebar = app.getByRole("group", { name: "Views and folders" });
  await expect(sidebar.getByRole("button", { name: "Work", exact: true })).toBeVisible();
  await expect(sidebar.getByRole("button", { name: "Personal", exact: true })).toBeVisible();

  // Open Work and verify its two pages landed there.
  await sidebar.getByRole("button", { name: "Work", exact: true }).click();
  const workItems = app.locator("[data-page-list-item]");
  await expect(workItems.getByText("Quarterly Report")).toBeVisible();
  await expect(workItems.getByText("Followups")).toBeVisible();

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
