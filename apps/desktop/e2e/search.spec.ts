import { expect } from "@playwright/test";

import { mod, quickAdd, test as appTest } from "./fixtures";

// ─── Search pages (Cmd+K) ──────────────────────────────────────────────────

appTest("search pages via Cmd+K @tier1", async ({ app }) => {
  await quickAdd(app, "alpha project");
  await quickAdd(app, "beta report");
  await quickAdd(app, "gamma notes");

  await app.keyboard.press(mod("Mod+k"));
  const dialog = app.getByRole("dialog", { name: "Search pages" });
  await expect(dialog).toBeVisible();

  await app.keyboard.type("beta");

  await expect(dialog.getByText("beta report")).toBeVisible();
  await expect(dialog.getByText("alpha project")).not.toBeVisible();

  await app.keyboard.press("Enter");

  await expect(dialog).not.toBeVisible();
  await expect(app.locator("[data-page-list-item][data-active='true']")).toContainText(
    "beta report"
  );
});

// ─── Fresh-boot empty state ────────────────────────────────────────────────
//
// On first launch (or any workspace with no opened pages yet), the palette
// has no recent-pages list to surface — it falls back to the "No recent
// pages" empty state. A regression that crashed the recent-list branch
// would leave the palette blank instead of guiding the user.

appTest("Cmd+K on fresh boot shows 'No recent pages' empty state @tier2", async ({ app }) => {
  await app.keyboard.press(mod("Mod+k"));
  const dialog = app.getByRole("dialog", { name: "Search pages" });
  await expect(dialog).toBeVisible();

  await expect(dialog.getByText("No recent pages")).toBeVisible();
});

// ─── Arrow-key navigation ──────────────────────────────────────────────────
//
// The palette tracks a `selectedIdx` that arrow keys move; Enter commits the
// highlighted item, not the first one. Default + Enter selects the first
// bm25-ranked match; ArrowDown + Enter must select a different match. We
// don't pin which page bm25 ranks first — we just prove that arrow keys
// shifted the highlight away from the default position.

appTest("Cmd+K arrow keys move highlight; Enter opens the highlighted result @tier2", async ({
  app,
}) => {
  await quickAdd(app, "alpha first");
  await quickAdd(app, "alpha second");
  await quickAdd(app, "alpha third");

  // Pass 1: open palette, query, Enter — opens whatever bm25 ranks first.
  await app.keyboard.press(mod("Mod+k"));
  const dialog = app.getByRole("dialog", { name: "Search pages" });
  await expect(dialog).toBeVisible();
  await app.keyboard.type("alpha");
  // All three matches present before any keypress.
  await expect(dialog.getByText("alpha first", { exact: true })).toBeVisible();
  await expect(dialog.getByText("alpha second", { exact: true })).toBeVisible();
  await expect(dialog.getByText("alpha third", { exact: true })).toBeVisible();
  await app.keyboard.press("Enter");
  await expect(dialog).not.toBeVisible();

  const firstOpened =
    (await app.locator("[data-page-list-item][data-active='true']").textContent())?.trim() ?? "";
  expect(firstOpened).toMatch(/^alpha /);

  // Pass 2: reopen, same query, ArrowDown twice, Enter — must open a
  // different page than pass 1, proving the highlight actually moved.
  await app.keyboard.press(mod("Mod+k"));
  await expect(dialog).toBeVisible();
  await app.keyboard.type("alpha");
  await expect(dialog.getByText("alpha first", { exact: true })).toBeVisible();
  await app.keyboard.press("ArrowDown");
  await app.keyboard.press("ArrowDown");
  await app.keyboard.press("Enter");
  await expect(dialog).not.toBeVisible();

  const secondOpened =
    (await app.locator("[data-page-list-item][data-active='true']").textContent())?.trim() ?? "";
  expect(secondOpened).toMatch(/^alpha /);
  expect(secondOpened).not.toBe(firstOpened);
});

// ─── Multi-token query narrows ─────────────────────────────────────────────
//
// FTS5's default tokenizer treats whitespace as an implicit AND between
// tokens. A single-token query returns all matches; adding a second token
// drops anything that doesn't contain both. Guards against a regression
// where the palette quotes or escapes the raw query in a way that turns
// multi-token searches into substring or OR matches.

appTest("Cmd+K multi-token query narrows to pages containing all tokens @tier2", async ({ app }) => {
  await quickAdd(app, "wallet report");
  await quickAdd(app, "wallet drift");
  await quickAdd(app, "wallet drift compass");

  await app.keyboard.press(mod("Mod+k"));
  const dialog = app.getByRole("dialog", { name: "Search pages" });
  await expect(dialog).toBeVisible();

  await app.keyboard.type("wallet");
  await expect(dialog.getByText("wallet report", { exact: true })).toBeVisible();
  await expect(dialog.getByText("wallet drift", { exact: true })).toBeVisible();
  await expect(dialog.getByText("wallet drift compass", { exact: true })).toBeVisible();

  // Adding "drift" drops the "wallet report" match. The remaining two pages
  // both contain "wallet" and "drift" — FTS5's default whitespace-delimited
  // tokenizer treats the space as an implicit AND.
  await app.keyboard.type(" drift");
  await expect(dialog.getByText("wallet drift", { exact: true })).toBeVisible();
  await expect(dialog.getByText("wallet drift compass", { exact: true })).toBeVisible();
  await expect(dialog.getByText("wallet report", { exact: true })).not.toBeVisible();
});
