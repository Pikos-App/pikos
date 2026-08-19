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

appTest(
  "Cmd+K arrow keys move highlight; Enter opens the highlighted result @tier2",
  async ({ app }) => {
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
  }
);

// ─── Multi-token query narrows ─────────────────────────────────────────────
//
// FTS5's default tokenizer treats whitespace as an implicit AND between
// tokens. A single-token query returns all matches; adding a second token
// drops anything that doesn't contain both. Guards against a regression
// where the palette quotes or escapes the raw query in a way that turns
// multi-token searches into substring or OR matches.

appTest(
  "Cmd+K multi-token query narrows to pages containing all tokens @tier2",
  async ({ app }) => {
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
  }
);

// ─── Operators ─────────────────────────────────────────────────────────────
//
// A query carrying `tag:` / `is:` / `priority:` / `due:` / `folder:` leaves the
// FTS5 path entirely and becomes a structured listPages filter. These pin the
// switch: an operator query narrows by metadata the index alone can't express,
// and an operator mixed with free text narrows by both.

appTest("Cmd+K tag: operator narrows to tagged pages @tier2", async ({ app }) => {
  await quickAdd(app, "alpha report #ledger");
  await quickAdd(app, "beta report");

  await app.keyboard.press(mod("Mod+k"));
  const dialog = app.getByRole("dialog", { name: "Search pages" });
  await expect(dialog).toBeVisible();

  await app.keyboard.type("tag:ledger");

  await expect(dialog.getByText("alpha report", { exact: true })).toBeVisible();
  await expect(dialog.getByText("beta report", { exact: true })).not.toBeVisible();
});

appTest("Cmd+K mixes an operator with free text @tier2", async ({ app }) => {
  await quickAdd(app, "alpha compass #ledger");
  await quickAdd(app, "beta compass #ledger");

  await app.keyboard.press(mod("Mod+k"));
  const dialog = app.getByRole("dialog", { name: "Search pages" });
  await expect(dialog).toBeVisible();

  // Both pages carry the tag; only one carries the word.
  await app.keyboard.type("tag:ledger alpha");

  await expect(dialog.getByText("alpha compass", { exact: true })).toBeVisible();
  await expect(dialog.getByText("beta compass", { exact: true })).not.toBeVisible();
});

// `is:done` asks for completed pages outright, so they appear without the
// "Show completed" toggle being pressed — and the toggle says so instead of
// offering to hide what the operator asked for.

appTest("Cmd+K is:done surfaces completed pages without the toggle @tier2", async ({ app }) => {
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
  await expect(dialog.getByText("Showing completed — is:done")).toBeVisible();
});

// ─── Command mode ──────────────────────────────────────────────────────────
//
// A leading ">" turns the palette into the command list, sourced from the
// keyboard registry. It works on the first character — the two-character floor
// is a property of the search index, not of the palette.

appTest("Cmd+K > lists commands and Enter runs the highlighted one @tier2", async ({ app }) => {
  await app.keyboard.press(mod("Mod+k"));
  const dialog = app.getByRole("dialog", { name: "Search pages" });
  await expect(dialog).toBeVisible();

  await app.keyboard.type(">");
  await expect(dialog.getByRole("button", { name: /New page/ })).toBeVisible();

  // Filtering runs on the text after the ">".
  await app.keyboard.type("keyboard");
  const command = dialog.getByRole("button", { name: /Keyboard shortcuts/ });
  await expect(command).toBeVisible();
  await expect(dialog.getByRole("button", { name: /New page/ })).not.toBeVisible();

  await app.keyboard.press("Enter");

  await expect(dialog).not.toBeVisible();
  await expect(app.getByRole("heading", { name: "Keyboard Shortcuts" })).toBeVisible();
});

// The shortcuts settings page is rendered from the same registry the command
// list reads, so a labelled binding shows up in both.

appTest("shortcuts settings lists registry-registered shortcuts @tier2", async ({ app }) => {
  await app.keyboard.press(mod("Mod+/"));

  await expect(app.getByRole("heading", { name: "Keyboard Shortcuts" })).toBeVisible();
  await expect(app.getByText("New page", { exact: true })).toBeVisible();
  await expect(app.getByText("Toggle sidebar", { exact: true })).toBeVisible();
  await expect(app.getByText("Bold", { exact: true })).toBeVisible();
});
