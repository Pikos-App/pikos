// E2E coverage for keyboard-only flows. The product target is a power-user
// app — every core path must be reachable without a mouse. This spec walks
// the full golden path (create → search → open → edit → save → revisit) plus
// the headline navigation shortcuts (Cmd+Shift+C, arrow-keys-in-calendar,
// t-jumps-to-today, Cmd+,) without a single click. A regression here means
// the keyboard layer dropped a binding or focus management broke.

import type { Page } from "@playwright/test";

import { expect, mod, quickAdd, test as appTest } from "./fixtures";

// ─── Full golden path: create → search → edit → revisit ─────────────────────
//
// Mouse-free: Cmd+N opens Quick Add; Enter creates the page; Cmd+K + arrows
// + Enter opens it; the editor focuses and the body is edited via typing;
// Cmd+W clears the active page; Cmd+K + Enter reopens the page and the body
// content is still there (autosave round-tripped through the in-memory
// adapter).

appTest("create → search → open → edit → revisit, keyboard only @tier2", async ({ app }) => {
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

  // Re-open via Cmd+K — body autosave should have round-tripped, so the
  // editor surfaces the typed text again. Wait for the result row before
  // Enter — the FTS query is debounced 150 ms, so pressing Enter on an
  // empty result list silently no-ops and leaves the palette open.
  await app.keyboard.press(mod("Mod+k"));
  await expect(palette).toBeVisible();
  await app.keyboard.type("keyboard target");
  await expect(palette.getByText("keyboard target")).toBeVisible();
  await app.keyboard.press("Enter");
  await expect(palette).not.toBeVisible();

  await expect(editor).toContainText("Notes from the keyboard.");
});

// ─── Calendar nav: Mod+Shift+C, ArrowKeys, t ────────────────────────────────
//
// Calendar's three core navigation bindings — toggle, week paging, jump to
// today — are routinely used together. Any shortcut going dark forces a
// mouse fallback. Doing all three from one test keeps the spec dense and
// asserts the bindings still co-exist (no Keyboard.register collision).

appTest("calendar week paging and jump-to-today via keyboard @tier2", async ({ app }) => {
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

  // 't' jumps back to the current week — same label as the initial state.
  await app.keyboard.press("t");
  await expect(heading).toHaveText(initialLabel ?? "");

  await app.keyboard.press(mod("Mod+Shift+c"));
  await expect(app.getByRole("region", { name: "Week calendar" })).not.toBeVisible();
});

// ─── Settings shortcut and Escape close ─────────────────────────────────────
//
// Cmd+, opens settings (already covered) but the keyboard-loop here verifies
// that Escape returns focus to the workspace shell — i.e. the user can re-
// trigger app shortcuts immediately, no stuck modal trap.

appTest("settings opens via Cmd+, and Escape returns control @tier2", async ({ app }) => {
  await app.keyboard.press(mod("Mod+,"));
  await expect(app.getByRole("heading", { name: "About" })).toBeVisible();

  await app.keyboard.press("Escape");
  await expect(app.getByRole("heading", { name: "About" })).not.toBeVisible();

  // Re-trigger an unrelated shortcut to prove no modal trap left over —
  // Cmd+N must still open Quick Add cleanly.
  await app.keyboard.press(mod("Mod+n"));
  await expect(app.getByRole("dialog", { name: "Quick add" })).toBeVisible();
  await app.keyboard.press("Escape");
  await expect(app.getByRole("dialog", { name: "Quick add" })).not.toBeVisible();
});

// ─── Cmd+Z undoes the most recent delete ───────────────────────────────────
//
// The undo toast carries a button that triggers `undoFn`; users can also
// hit Cmd+Z to fire the same action without reaching for the mouse. The
// binding is gated on `allowInInputs:false`, so editor undo (Tiptap) keeps
// working unchanged.

appTest("Cmd+Z undoes the most recent page delete @tier2", async ({ app }) => {
  await quickAdd(app, "trash this");

  const item = app.locator("[data-page-list-item]").filter({ hasText: "trash this" });
  await expect(item).toBeVisible();

  await item.click({ button: "right" });
  await app.getByRole("menuitem", { name: "Delete" }).click();
  await expect(item).not.toBeVisible();
  await expect(app.getByRole("alert", { name: /trash this/ })).toBeVisible();

  // Cmd+Z while focus is in the page list (no editor/input focus): the
  // toast's undo action fires, page is restored, toast clears.
  await app.locator("body").click({ position: { x: 0, y: 0 } });
  await app.keyboard.press(mod("Mod+z"));

  await expect(item).toBeVisible();
  await expect(app.getByRole("alert", { name: /trash this/ })).not.toBeVisible();
});

// ─── Mod+1 switches to first folder by index ────────────────────────────────
//
// The Mod+1..9 bindings are how power users hop between folders. Test the
// first one — the implementation registers all nine through one effect, so
// breaking any of them breaks the rest the same way.

appTest("Mod+1 switches active view to the first folder @tier2", async ({ app }) => {
  // Seed a folder so Mod+1 has a target.
  await app
    .getByRole("toolbar", { name: "Folder actions" })
    .getByRole("button", { name: "New Folder" })
    .click();
  await app.keyboard.press(mod("Mod+a"));
  await app.keyboard.type("Active");
  await app.keyboard.press("Enter");

  // Switch away to Inbox so Mod+1 actually moves the view.
  await app.getByRole("button", { name: /^Inbox/ }).click();
  await expect(app.getByRole("button", { name: /^Inbox/ })).toHaveAttribute(
    "aria-current",
    "true"
  );

  await app.keyboard.press(mod("Mod+1"));
  const folderBtn = app.getByRole("button", { name: "Active", exact: true });
  await expect(folderBtn).toHaveAttribute("aria-current", "true");
});

// ─── Arrow-key list navigation (page list, folder list, scoping) ─────────────
//
// Up/Down navigation for the page list is registered as a *global* shortcut so
// it works regardless of which non-editable element holds focus. The folder
// list keeps its own arrow handler. The two must not fight: folder focus →
// folders move; otherwise the page list moves; and a focused control that
// natively consumes arrows (a popover trigger / open menu) must take priority
// over both. These specs lock down that contract — the focus/role-based
// gating only really shows up under live keyboard dispatch, so it's E2E-only.

async function seedPages(app: Page, titles: string[]) {
  for (const title of titles) await quickAdd(app, title);
}

appTest("Arrow Up/Down navigates the page list off-list focus @tier2", async ({ app }) => {
  await seedPages(app, ["nav-a", "nav-b", "nav-c"]);

  const list = app.locator("[data-page-list-item]");
  const active = app.locator("[data-page-list-item][data-active='true']");

  // Activate the first row, then drop focus to <body> — the regression target:
  // global registration means arrows still navigate when the list isn't focused.
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

appTest("Space toggles completion of the active page off-list focus @tier2", async ({ app }) => {
  await seedPages(app, ["done-me"]);

  const list = app.locator("[data-page-list-item]");
  const item = list.filter({ hasText: "done-me" });

  // Activate it, then blur — same global-shortcut path the arrow nav uses.
  await item.click();
  await expect(app.locator("[data-page-list-item][data-active='true']")).toHaveCount(1);
  await app.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());

  // Space marks it done, dropping it out of the visible (non-completed) list.
  await app.keyboard.press("Space");
  await expect(item).not.toBeVisible();
});

// ─── Cmd+Shift+Backspace deletes the active page from the title input ──────
//
// Plain Cmd+Backspace gets eaten by the OS line-delete when an input has
// focus. The Shift alias keeps `allowInInputs: true` + `preventDefault: true`
// so the page can be deleted while editing its title — the case the user
// actually needs since the popover/editor lands focus there by default.

appTest("Cmd+Shift+Backspace deletes the active page from the title input @tier2", async ({ app }) => {
  await quickAdd(app, "delete me from title");
  const item = app.locator("[data-page-list-item]").filter({ hasText: "delete me from title" });
  await expect(item).toBeVisible();

  // Open the page; click the title to focus it (div → textarea swap).
  await item.click();
  await expect(app.getByRole("textbox", { name: "Page content" })).toBeVisible();
  await app.getByRole("button", { name: "Page title" }).click();
  const titleInput = app.getByRole("textbox", { name: "Page title" });
  await expect(titleInput).toBeFocused();

  await app.keyboard.press(mod("Mod+Shift+Backspace"));
  await expect(item).not.toBeVisible();
});

// ─── Cmd+Shift+Backspace is a no-op while a modal dialog is open ───────────
//
// Guards the `when: () => openDialog === null && !settingsOpen` predicate.
// Quick Add (or Search Palette / Settings) puts the user in a context where
// the background activePage is NOT what they meant to delete — pressing the
// chord must NOT touch it. The OS line-delete inside the input is fine.

appTest("Cmd+Shift+Backspace does not delete the active page while Quick Add is open @tier2", async ({ app }) => {
  // Seed a page so there's a background activePage candidate.
  await quickAdd(app, "background survivor");
  const item = app.locator("[data-page-list-item]").filter({ hasText: "background survivor" });
  await item.click();
  await expect(item).toHaveAttribute("data-active", "true");

  await app.keyboard.press(mod("Mod+n"));
  const dialog = app.getByRole("dialog", { name: "Quick add" });
  await expect(dialog).toBeVisible();

  // Type something so an OS line-delete has a target, then press the chord.
  const input = app.getByRole("textbox", { name: "Quick add input" });
  await input.fill("scratch text");
  await app.keyboard.press(mod("Mod+Shift+Backspace"));

  await expect(dialog).toBeVisible();
  await expect(item).toBeVisible();
});

appTest("Arrow keys drive a focused dropdown, not the page list @tier2", async ({ app }) => {
  await seedPages(app, ["dd-a", "dd-b"]);

  const list = app.locator("[data-page-list-item]");
  const active = app.locator("[data-page-list-item][data-active='true']");

  // Activate a page so there *is* something the page list could navigate.
  await list.first().click();
  const activeIdBefore = await active.getAttribute("data-page-id");
  expect(activeIdBefore).toBeTruthy();

  // Focus the "Sort folders" popover trigger (aria-haspopup). ArrowDown should
  // open the menu — the trigger owns the key — and must NOT move the page list.
  await app.getByRole("toolbar", { name: "Folder actions" }).getByRole("button", { name: "Sort folders" }).focus();
  await app.keyboard.press("ArrowDown");

  const alphabetical = app.getByRole("menuitem", { name: /Alphabetical/ });
  await expect(alphabetical).toBeVisible();
  // Page list did not navigate.
  await expect(active).toHaveAttribute("data-page-id", activeIdBefore!);

  // A second ArrowDown moves the highlight *within the menu*, still not the page.
  await app.keyboard.press("ArrowDown");
  await expect(active).toHaveAttribute("data-page-id", activeIdBefore!);

  await app.keyboard.press("Escape");
  await expect(alphabetical).not.toBeVisible();
});
