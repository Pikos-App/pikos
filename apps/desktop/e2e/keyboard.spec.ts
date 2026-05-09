// E2E coverage for keyboard-only flows. The product target is a power-user
// app — every core path must be reachable without a mouse. This spec walks
// the full golden path (create → search → open → edit → save → revisit) plus
// the headline navigation shortcuts (Cmd+Shift+C, arrow-keys-in-calendar,
// t-jumps-to-today, Cmd+,) without a single click. A regression here means
// the keyboard layer dropped a binding or focus management broke.

import { expect, mod, quickAdd, test as appTest } from "./fixtures";

// ─── Full golden path: create → search → edit → revisit ─────────────────────
//
// Mouse-free: Cmd+N opens Quick Add; Enter creates the page; Cmd+K + arrows
// + Enter opens it; the editor focuses and the body is edited via typing;
// Cmd+W clears the active page; Cmd+K + Enter reopens the page and the body
// content is still there (autosave round-tripped through the in-memory
// adapter).

appTest("create → search → open → edit → revisit, keyboard only @tier2", async ({ app }) => {
  // 1. Quick Add via shortcut.
  await app.keyboard.press(mod("Mod+n"));
  const quickAdd = app.getByRole("dialog", { name: "Quick add" });
  await expect(quickAdd).toBeVisible();
  await expect(app.getByPlaceholder(/what's on your mind/i)).toBeFocused();
  await app.keyboard.type("keyboard target");
  await app.keyboard.press("Enter");
  await expect(quickAdd).not.toBeVisible();

  // 2. Cmd+K → arrows aren't needed (single result), Enter opens.
  await app.keyboard.press(mod("Mod+k"));
  const palette = app.getByRole("dialog", { name: "Search pages" });
  await expect(palette).toBeVisible();
  await app.keyboard.type("keyboard target");
  await expect(palette.getByText("keyboard target")).toBeVisible();
  await app.keyboard.press("Enter");
  await expect(palette).not.toBeVisible();

  // 3. The active list item is the freshly-opened page; pressing Enter on it
  //    routes through openPage() and focuses the editor body. The list item
  //    receives focus when clicked from search palette? No — palette → openPage
  //    sets the active page and the editor body becomes the focus target via
  //    its own auto-focus path. Type body content directly.
  const editor = app.getByRole("textbox", { name: "Page content" });
  // Click-free focus: Enter on the focused list item routes to openPage and
  // focuses the editor (PageListItem onKeyDown handles Enter).
  const activeItem = app.locator("[data-page-list-item][data-active='true']");
  await activeItem.focus();
  await app.keyboard.press("Enter");
  await expect(editor).toBeFocused();

  await app.keyboard.type("Notes from the keyboard.");
  await expect(editor).toContainText("Notes from the keyboard.");

  // 4. Cmd+W clears the active page (closes editor scope).
  await app.keyboard.press(mod("Mod+w"));
  await expect(app.locator("[data-page-list-item][data-active='true']")).toHaveCount(0);

  // 5. Re-open via Cmd+K — body autosave should have round-tripped, so the
  //    editor surfaces the typed text again. Wait for the result row before
  //    Enter — the FTS query is debounced 150 ms, so pressing Enter on an
  //    empty result list silently no-ops and leaves the palette open.
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
  // Toggle into calendar via shortcut.
  await app.keyboard.press(mod("Mod+Shift+c"));
  await expect(app.getByRole("region", { name: "Week calendar" })).toBeVisible();

  const heading = app.getByRole("heading", { name: "Visible week" });
  const initialLabel = await heading.textContent();

  // Right arrow advances one week.
  await app.keyboard.press("ArrowRight");
  const advancedLabel = await heading.textContent();
  expect(advancedLabel).not.toBe(initialLabel);

  // Right arrow + Right arrow goes further forward.
  await app.keyboard.press("ArrowRight");
  const furtherLabel = await heading.textContent();
  expect(furtherLabel).not.toBe(advancedLabel);

  // 't' jumps back to the current week — same label as the initial state.
  await app.keyboard.press("t");
  await expect(heading).toHaveText(initialLabel ?? "");

  // Toggle back to editor via the same shortcut.
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

  // Right-click → Delete. Page disappears, toast appears.
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
  // Seed: create a folder so Mod+1 has a target. New Folder + rename.
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

  // Mod+1 → first folder ("Active") is selected.
  await app.keyboard.press(mod("Mod+1"));
  const folderBtn = app.getByRole("button", { name: "Active", exact: true });
  await expect(folderBtn).toHaveAttribute("aria-current", "true");
});
