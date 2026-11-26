// Keyboard-only flows: every core path must be reachable without a mouse.

import type { Page } from "@playwright/test";

import { test as appTest, createFolder, expect, mod, quickAdd } from "./fixtures";

appTest("create → search → open → edit → revisit, keyboard only", async ({ app }) => {
  await app.keyboard.press(mod("Mod+n"));
  const quickAdd = app.getByRole("dialog", { name: "Quick add" });
  await expect(quickAdd).toBeVisible();
  await expect(app.getByRole("textbox", { name: "Quick add input" })).toBeFocused();
  await app.keyboard.type("keyboard target");
  await app.keyboard.press("Enter");
  await expect(quickAdd).not.toBeVisible();

  await app.keyboard.press(mod("Mod+k"));
  const palette = app.getByRole("dialog", { name: "Search pages" });
  await expect(palette).toBeVisible();
  await app.keyboard.type("keyboard target");
  await expect(palette.getByText("keyboard target")).toBeVisible();
  await app.keyboard.press("Enter");
  await expect(palette).not.toBeVisible();

  const editor = app.getByRole("textbox", { name: "Page content" });
  const activeItem = app.locator("[data-page-list-item][data-active='true']");
  await activeItem.focus();
  await app.keyboard.press("Enter");
  await expect(editor).toBeFocused();

  await app.keyboard.type("Notes from the keyboard.");
  await expect(editor).toContainText("Notes from the keyboard.");

  await app.keyboard.press(mod("Mod+w"));
  await expect(app.locator("[data-page-list-item][data-active='true']")).toHaveCount(0);

  // Wait for the result row before Enter: the FTS query is debounced 150 ms, so Enter on an empty list
  // silently no-ops and leaves the palette open.
  await app.keyboard.press(mod("Mod+k"));
  await expect(palette).toBeVisible();
  await app.keyboard.type("keyboard target");
  await expect(palette.getByText("keyboard target")).toBeVisible();
  await app.keyboard.press("Enter");
  await expect(palette).not.toBeVisible();

  await expect(editor).toContainText("Notes from the keyboard.");
});

appTest("calendar week paging and jump-to-today via keyboard", async ({ app }) => {
  await app.keyboard.press(mod("Mod+Shift+c"));
  await expect(app.getByRole("region", { name: "Week calendar" })).toBeVisible();

  const heading = app.getByRole("heading", { name: "Visible week" });
  const initialLabel = await heading.textContent();

  await app.keyboard.press("ArrowRight");
  const advancedLabel = await heading.textContent();
  expect(advancedLabel).not.toBe(initialLabel);

  await app.keyboard.press("ArrowRight");
  const furtherLabel = await heading.textContent();
  expect(furtherLabel).not.toBe(advancedLabel);

  await app.keyboard.press("t");
  await expect(heading).toHaveText(initialLabel ?? "");

  await app.keyboard.press(mod("Mod+Shift+c"));
  await expect(app.getByRole("region", { name: "Week calendar" })).not.toBeVisible();
});

appTest("settings opens via Cmd+, and Escape returns control", async ({ app }) => {
  await app.keyboard.press(mod("Mod+,"));
  await expect(app.getByRole("heading", { name: "About" })).toBeVisible();

  await app.keyboard.press("Escape");
  await expect(app.getByRole("heading", { name: "About" })).not.toBeVisible();

  // Cmd+N must still open Quick Add, proving no modal trap is left.
  await app.keyboard.press(mod("Mod+n"));
  await expect(app.getByRole("dialog", { name: "Quick add" })).toBeVisible();
  await app.keyboard.press("Escape");
  await expect(app.getByRole("dialog", { name: "Quick add" })).not.toBeVisible();
});

// Cmd+Z is gated on allowInInputs:false, so editor undo (Tiptap) is unaffected.

appTest("Cmd+Z undoes the most recent page delete", { tag: ["@TRASH-02:3"] }, async ({ app }) => {
  await quickAdd(app, "trash this");

  const item = app.locator("[data-page-list-item]").filter({ hasText: "trash this" });
  await expect(item).toBeVisible();

  await item.click({ button: "right" });
  await app.getByRole("menuitem", { name: "Delete" }).click();
  await expect(item).not.toBeVisible();
  await expect(app.getByRole("alert", { name: /trash this/ })).toBeVisible();

  await app.locator("body").click({ position: { x: 0, y: 0 } });
  await app.keyboard.press(mod("Mod+z"));

  await expect(item).toBeVisible();
  await expect(app.getByRole("alert", { name: /trash this/ })).not.toBeVisible();
});

appTest("Mod+1 switches active view to the first folder", async ({ app }) => {
  await createFolder(app, "Active");

  // Switch away to Inbox so Mod+1 actually moves the view.
  await app.getByRole("button", { name: /^Inbox/ }).click();
  await expect(app.getByRole("button", { name: /^Inbox/ })).toHaveAttribute("aria-current", "true");

  await app.keyboard.press(mod("Mod+1"));
  const folderBtn = app.getByRole("button", { exact: true, name: "Active" });
  await expect(folderBtn).toHaveAttribute("aria-current", "true");
});

// Page-list Up/Down is a global shortcut, working whichever non-editable element has focus; the folder list
// keeps its own handler. Folder focus moves folders, and a control that natively consumes arrows (popover
// trigger, open menu) wins over both. Focus/role gating only shows under live keyboard dispatch.

async function seedPages(app: Page, titles: string[]) {
  for (const title of titles) await quickAdd(app, title);
}

appTest("Arrow Up/Down navigates the page list off-list focus", async ({ app }) => {
  await seedPages(app, ["nav-a", "nav-b", "nav-c"]);

  const list = app.locator("[data-page-list-item]");
  const active = app.locator("[data-page-list-item][data-active='true']");

  // Drop focus to <body>: global registration means arrows still navigate when the list isn't focused.
  await list.first().click();
  const firstId = await active.getAttribute("data-page-id");
  expect(firstId).toBeTruthy();
  await app.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());

  await app.keyboard.press("ArrowDown");
  await expect(active).not.toHaveAttribute("data-page-id", firstId!);
  const secondId = await active.getAttribute("data-page-id");

  await app.keyboard.press("ArrowUp");
  await expect(active).toHaveAttribute("data-page-id", firstId!);
  expect(secondId).not.toBe(firstId);
});

async function deleteMiddlePageAndStep(app: Page, key: "ArrowDown" | "ArrowUp") {
  const list = app.locator("[data-page-list-item]");
  await expect(list).toHaveCount(3);
  const before = await list.evaluateAll((rows) => rows.map((row) => row.ariaLabel ?? ""));

  await list.nth(1).click();
  await app.getByRole("button", { name: "Page title" }).click();
  await app.keyboard.press(mod("Mod+Shift+Backspace"));
  await expect(list).toHaveCount(2);

  await app.keyboard.press(key);
  const expected = key === "ArrowDown" ? before[2] : before[0];
  await expect(app.getByLabel("Page title")).toHaveText(expected!);
}

appTest(
  "after deleting the open page in a folder, Down opens the one that followed it",
  { tag: ["@LIST-17:4"] },
  async ({ app }) => {
    await createFolder(app, "Steps");
    await seedPages(app, ["step-a", "step-b", "step-c"]);
    await deleteMiddlePageAndStep(app, "ArrowDown");
  }
);

appTest(
  "after deleting the open page in a folder, Up opens the one before it",
  { tag: ["@LIST-17:4"] },
  async ({ app }) => {
    await createFolder(app, "Steps");
    await seedPages(app, ["step-a", "step-b", "step-c"]);
    await deleteMiddlePageAndStep(app, "ArrowUp");
  }
);

appTest(
  "after deleting the open page on Today, Down opens the one that followed it",
  { tag: ["@LIST-17:4"] },
  async ({ app }) => {
    await seedPages(app, ["due-a @today", "due-b @today", "due-c @today"]);
    await app.getByRole("button", { name: /^Today/ }).click();
    await deleteMiddlePageAndStep(app, "ArrowDown");
  }
);

appTest(
  "after deleting the open page on Today, Up opens the one before it",
  { tag: ["@LIST-17:4"] },
  async ({ app }) => {
    await seedPages(app, ["due-a @today", "due-b @today", "due-c @today"]);
    await app.getByRole("button", { name: /^Today/ }).click();
    await deleteMiddlePageAndStep(app, "ArrowUp");
  }
);

appTest("Space toggles completion of the active page off-list focus", async ({ app }) => {
  await seedPages(app, ["done-me"]);

  const list = app.locator("[data-page-list-item]");
  const item = list.filter({ hasText: "done-me" });

  await item.click();
  await expect(app.locator("[data-page-list-item][data-active='true']")).toHaveCount(1);
  await app.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());

  await app.keyboard.press("Space");
  await expect(item).not.toBeVisible();
});

// Plain Cmd+Backspace is eaten by the OS line-delete in an input; the Shift alias keeps allowInInputs and
// preventDefault so the page can be deleted while editing its title.

appTest(
  "Cmd+Shift+Backspace deletes the active page from the title input",
  { tag: ["@TRASH-01:5"] },
  async ({ app }) => {
    await quickAdd(app, "delete me from title");
    const item = app.locator("[data-page-list-item]").filter({ hasText: "delete me from title" });
    await expect(item).toBeVisible();

    await item.click();
    await expect(app.getByRole("textbox", { name: "Page content" })).toBeVisible();
    await app.getByRole("button", { name: "Page title" }).click();
    const titleInput = app.getByRole("textbox", { name: "Page title" });
    await expect(titleInput).toBeFocused();

    await app.keyboard.press(mod("Mod+Shift+Backspace"));
    await expect(item).not.toBeVisible();
  }
);

// Guards the `when: () => openDialog === null && !settingsOpen` predicate: with a modal open, the chord must
// not touch the background activePage.

appTest(
  "Cmd+Shift+Backspace does not delete the active page while Quick Add is open",
  async ({ app }) => {
    await quickAdd(app, "background survivor");
    const item = app.locator("[data-page-list-item]").filter({ hasText: "background survivor" });
    await item.click();
    await expect(item).toHaveAttribute("data-active", "true");

    await app.keyboard.press(mod("Mod+n"));
    const dialog = app.getByRole("dialog", { name: "Quick add" });
    await expect(dialog).toBeVisible();

    // Type something so an OS line-delete has a target.
    const input = app.getByRole("textbox", { name: "Quick add input" });
    await input.fill("scratch text");
    await app.keyboard.press(mod("Mod+Shift+Backspace"));

    await expect(dialog).toBeVisible();
    await expect(item).toBeVisible();
  }
);

appTest("Arrow keys drive a focused dropdown, not the page list", async ({ app }) => {
  await seedPages(app, ["dd-a", "dd-b"]);

  const list = app.locator("[data-page-list-item]");
  const active = app.locator("[data-page-list-item][data-active='true']");

  await list.first().click();
  const activeIdBefore = await active.getAttribute("data-page-id");
  expect(activeIdBefore).toBeTruthy();

  // The trigger owns ArrowDown (it opens the menu); the page list must not move.
  await app
    .getByRole("toolbar", { name: "Folder actions" })
    .getByRole("button", { name: "Sort folders" })
    .focus();
  await app.keyboard.press("ArrowDown");

  const alphabetical = app.getByRole("menuitem", { name: /Alphabetical/ });
  await expect(alphabetical).toBeVisible();
  await expect(active).toHaveAttribute("data-page-id", activeIdBefore!);

  await app.keyboard.press("ArrowDown");
  await expect(active).toHaveAttribute("data-page-id", activeIdBefore!);

  await app.keyboard.press("Escape");
  await expect(alphabetical).not.toBeVisible();
});

// Hidden panels are zero-width, not unmounted, and their contents overflow rather than clip, so they keep
// taking Tab focus. Both sit above the editor, so the first Tab from the top must land in the editor.

appTest(
  "a focus session's hidden panels leave the Tab order",
  { tag: ["@EDIT-22"] },
  async ({ app }) => {
    await quickAdd(app, "focus target");
    await app.locator("[data-page-list-item]").getByText("focus target").click();
    await app.getByRole("button", { name: "Start focus timer" }).click();

    // Start at <body>: Tiptap owns Tab and never gives focus up, so a walk that
    // starts inside the editor would pass whatever the panels did.
    await app.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());

    const hiddenPanels = app.locator(
      'nav[aria-label="Workspace navigation"], [aria-label="Page actions"], [role="group"][aria-label="Inbox"]'
    );

    // Naming the first Tab target would pin this to one platform: macOS keeps buttons out of the Tab order,
    // elsewhere it stops at the first editor-pane button. What must hold on both is that no step lands in a hidden panel.
    for (let i = 0; i < 6; i++) {
      await app.keyboard.press("Tab");
      await expect(hiddenPanels.locator(":focus")).toHaveCount(0);
    }
  }
);
