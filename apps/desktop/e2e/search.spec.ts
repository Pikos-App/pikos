import { expect } from "@playwright/test";

import { test as appTest, mod, quickAdd } from "./fixtures";

appTest("search pages via Cmd+K @smoke", async ({ app }) => {
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

appTest(
  "Cmd+K on fresh boot shows 'No recent pages' empty state",
  { tag: ["@SRCH-02:3"] },
  async ({ app }) => {
    await app.keyboard.press(mod("Mod+k"));
    const dialog = app.getByRole("dialog", { name: "Search pages" });
    await expect(dialog).toBeVisible();

    await expect(dialog.getByText("No recent pages")).toBeVisible();
  }
);

// Default + Enter selects the first bm25-ranked match; ArrowDown + Enter must select a different one. Which
// page bm25 ranks first isn't pinned; the test only proves the highlight moved.

appTest("Cmd+K arrow keys move highlight; Enter opens the highlighted result", async ({ app }) => {
  await quickAdd(app, "alpha first");
  await quickAdd(app, "alpha second");
  await quickAdd(app, "alpha third");

  await app.keyboard.press(mod("Mod+k"));
  const dialog = app.getByRole("dialog", { name: "Search pages" });
  await expect(dialog).toBeVisible();
  await app.keyboard.type("alpha");
  await expect(dialog.getByText("alpha first", { exact: true })).toBeVisible();
  await expect(dialog.getByText("alpha second", { exact: true })).toBeVisible();
  await expect(dialog.getByText("alpha third", { exact: true })).toBeVisible();
  await app.keyboard.press("Enter");
  await expect(dialog).not.toBeVisible();

  const firstOpened =
    (await app.locator("[data-page-list-item][data-active='true']").textContent())?.trim() ?? "";
  expect(firstOpened).toMatch(/^alpha /);

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

// FTS5's default tokenizer treats whitespace as an implicit AND, so a second token drops matches lacking it.
// Guards against quoting or escaping that would turn multi-token searches into substring or OR matches.

appTest("Cmd+K multi-token query narrows to pages containing all tokens", async ({ app }) => {
  await quickAdd(app, "wallet report");
  await quickAdd(app, "wallet drift");
  await quickAdd(app, "wallet drift compass");

  await app.keyboard.press(mod("Mod+k"));
  const dialog = app.getByRole("dialog", { name: "Search pages" });
  await expect(dialog).toBeVisible();

  // By row name: highlighting splits a title into pieces, so its text isn't one node.
  const result = (title: string) => dialog.getByRole("button", { exact: true, name: title });

  await app.keyboard.type("wallet");
  await expect(result("wallet report")).toBeVisible();
  await expect(result("wallet drift")).toBeVisible();
  await expect(result("wallet drift compass")).toBeVisible();

  // Adding "drift" drops the "wallet report" match: the default tokenizer treats the space as an implicit AND.
  await app.keyboard.type(" drift");
  await expect(result("wallet drift")).toBeVisible();
  await expect(result("wallet drift compass")).toBeVisible();
  await expect(result("wallet report")).not.toBeVisible();
});

// A query with `tag:` / `is:` / `priority:` / `due:` / `folder:` leaves the FTS5 path and becomes a structured
// listPages filter; an operator mixed with free text narrows by both.

appTest("Cmd+K tag: operator narrows to tagged pages", async ({ app }) => {
  await quickAdd(app, "alpha report #ledger");
  await quickAdd(app, "beta report");

  await app.keyboard.press(mod("Mod+k"));
  const dialog = app.getByRole("dialog", { name: "Search pages" });
  await expect(dialog).toBeVisible();

  await app.keyboard.type("tag:ledger");

  await expect(dialog.getByText("alpha report", { exact: true })).toBeVisible();
  await expect(dialog.getByText("beta report", { exact: true })).not.toBeVisible();
});

appTest("Cmd+K mixes an operator with free text", async ({ app }) => {
  await quickAdd(app, "alpha compass #ledger");
  await quickAdd(app, "beta compass #ledger");

  await app.keyboard.press(mod("Mod+k"));
  const dialog = app.getByRole("dialog", { name: "Search pages" });
  await expect(dialog).toBeVisible();

  await app.keyboard.type("tag:ledger alpha");

  await expect(dialog.getByText("alpha compass", { exact: true })).toBeVisible();
  await expect(dialog.getByText("beta compass", { exact: true })).not.toBeVisible();
});

// `is:done` asks for completed pages outright, so they appear without the
// "Show completed" toggle being pressed — and the toggle says so instead of
// offering to hide what the operator asked for.

appTest("Cmd+K is:done surfaces completed pages without the toggle", async ({ app }) => {
  await quickAdd(app, "wallet archived");
  await quickAdd(app, "wallet active");

  const pageItem = app.locator("[data-page-list-item]").filter({ hasText: "wallet archived" });
  await pageItem.getByRole("checkbox", { name: "Mark done" }).click();
  await expect(pageItem).not.toBeVisible();

  await app.keyboard.press(mod("Mod+k"));
  const dialog = app.getByRole("dialog", { name: "Search pages" });
  await expect(dialog).toBeVisible();

  await app.keyboard.type("is:done wallet");

  await expect(dialog.getByText("wallet archived", { exact: true })).toBeVisible();
  await expect(dialog.getByText("wallet active", { exact: true })).not.toBeVisible();
  await expect(dialog.getByText("Showing completed: is:done")).toBeVisible();
});

// A leading ">" turns the palette into the command list from the keyboard registry, and works on the first
// character: the two-character floor belongs to the search index.

appTest("Cmd+K > lists commands and Enter runs the highlighted one", async ({ app }) => {
  await app.keyboard.press(mod("Mod+k"));
  const dialog = app.getByRole("dialog", { name: "Search pages" });
  await expect(dialog).toBeVisible();

  await app.keyboard.type(">");
  await expect(dialog.getByRole("button", { name: /New page/ })).toBeVisible();

  await app.keyboard.type("keyboard");
  const command = dialog.getByRole("button", { name: /Keyboard shortcuts/ });
  await expect(command).toBeVisible();
  await expect(dialog.getByRole("button", { name: /New page/ })).not.toBeVisible();

  await app.keyboard.press("Enter");

  await expect(dialog).not.toBeVisible();
  await expect(app.getByRole("heading", { name: "Keyboard Shortcuts" })).toBeVisible();
});

// Cmd+Shift+K opens straight into command mode. Radix's focus scope selects an input's contents on autofocus,
// so the prefix must survive the first keystroke rather than be replaced by it.

appTest("Cmd+Shift+K opens in command mode and typing keeps the prefix", async ({ app }) => {
  await app.keyboard.press(mod("Mod+Shift+k"));
  const dialog = app.getByRole("dialog", { name: "Search pages" });
  await expect(dialog).toBeVisible();

  const input = dialog.getByRole("textbox");
  await expect(input).toHaveValue("> ");
  await expect(dialog.getByRole("button", { name: /New page/ })).toBeVisible();

  await app.keyboard.type("keyboard");
  await expect(input).toHaveValue("> keyboard");
  await expect(dialog.getByRole("button", { name: /Keyboard shortcuts/ })).toBeVisible();
});

// The shortcuts settings page is rendered from the same registry the command
// list reads, so a labelled binding shows up in both.

appTest("shortcuts settings lists registry-registered shortcuts", async ({ app }) => {
  await app.keyboard.press(mod("Mod+/"));

  await expect(app.getByRole("heading", { name: "Keyboard Shortcuts" })).toBeVisible();
  await expect(app.getByText("New page", { exact: true })).toBeVisible();
  await expect(app.getByText("Toggle sidebar", { exact: true })).toBeVisible();
  await expect(app.getByText("Bold", { exact: true })).toBeVisible();
});
