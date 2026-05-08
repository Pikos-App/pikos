// E2E coverage for editing page metadata on an existing page via the editor
// byline. Quick Add covers the *creation* path for these fields; here we
// lock down the *edit* path — a regression in the byline plumbing would
// make existing pages frozen at whatever priority/tags/schedule they were
// created with.

import type { Page } from "@playwright/test";

import { expect, mod, quickAdd, test as appTest } from "./fixtures";

/** Open a page in the editor and return when the byline is mounted. The
 *  byline carries every editable metadata chip we assert against. */
async function openPageInEditor(app: Page, title: string) {
  await app.locator("[data-page-list-item]").filter({ hasText: title }).click();
  // The status toggle ("Open"/"Done") is the leftmost byline chip and the
  // most reliable byline-mounted signal — its presence proves the metadata
  // header rendered.
  await expect(app.getByRole("button", { name: "Mark done" })).toBeVisible();
}

// ─── Priority edit on existing page ─────────────────────────────────────────
//
// PriorityDropdown's byline trigger carries an aria-label of "Priority: <Label>".
// The accessible name flips immediately after a menuitem is selected — that's
// the contract: a regression in the dropdown→onSelect→updatePage→re-render
// chain shows up here.

appTest("priority edit via byline reflects in the chip aria-label @tier2", async ({ app }) => {
  await quickAdd(app, "policy review");
  await openPageInEditor(app, "policy review");

  // Default is priority=0 ("Priority" label).
  const priorityChip = app.getByRole("button", { name: "Priority: Priority" });
  await expect(priorityChip).toBeVisible();

  // Open the dropdown and pick High.
  await priorityChip.click();
  await app.getByRole("menuitem", { name: /High/ }).click();

  // Aria-label flips. The old chip label is gone, the new one present.
  await expect(app.getByRole("button", { name: "Priority: High" })).toBeVisible();
  await expect(priorityChip).not.toBeVisible();

  // Round-trip: change again to Low — proves the menu isn't sticky on the
  // first selection.
  await app.getByRole("button", { name: "Priority: High" }).click();
  await app.getByRole("menuitem", { name: /Low/ }).click();
  await expect(app.getByRole("button", { name: "Priority: Low" })).toBeVisible();
});

// ─── Tag add + remove via byline ────────────────────────────────────────────
//
// TagsPopover lets users type a tag name and Enter to create + select.
// Toggling an existing tag removes it. The chip's aria-label spells out the
// selected tag list — empty state reads "Tags: none".

appTest("tags add and remove via byline updates the chip @tier2", async ({ app }) => {
  await quickAdd(app, "field research");
  await openPageInEditor(app, "field research");

  // Default chip — no tags selected.
  const emptyChip = app.getByRole("button", { name: "Tags: none" });
  await expect(emptyChip).toBeVisible();

  // Open popover. Type a new tag name and Enter — TagsPopover.onEnter
  // creates + selects it (lowercased). The popover stays open for
  // multi-select, so close it explicitly with Escape before the next assert
  // (otherwise clicking the chip again would close the open popover, not
  // re-open it).
  await emptyChip.click();
  const search = app.getByPlaceholder("Search or create…");
  await search.fill("research");
  await app.keyboard.press("Enter");
  await app.keyboard.press("Escape");

  // The chip flips to show the selected tag.
  await expect(app.getByRole("button", { name: "Tags: research" })).toBeVisible();

  // Re-open and toggle the tag off. The selected entry exists in the
  // popover list as a button labelled "#research" — clicking deselects.
  await app.getByRole("button", { name: "Tags: research" }).click();
  await expect(app.getByPlaceholder("Search or create…")).toBeVisible();
  await app.getByRole("button", { name: "#research" }).click();
  await app.keyboard.press("Escape");

  // Back to the empty state — clearing the only tag.
  await expect(app.getByRole("button", { name: "Tags: none" })).toBeVisible();
});

// ─── Schedule edit via byline → page surfaces in Today ──────────────────────
//
// Clicking "Tomorrow" in the DateTimePicker quick-picks lands a definite
// scheduled date on the page. Cross-cuts byline → workspace.scheduleOnce →
// Today smart-view filter.

appTest(
  "schedule via byline picker shows the page in Today after picking Today @tier2",
  async ({ app }) => {
    // Create from Inbox — when the active view is Today, QuickAdd auto-anchors
    // schedules to today and defeats the "originally unscheduled" premise.
    await quickAdd(app, "field research");
    await openPageInEditor(app, "field research");

    // Schedule chip starts in the unset state.
    const setSchedule = app.getByRole("button", { name: "Set schedule" });
    await expect(setSchedule).toBeVisible();
    await setSchedule.click();

    // Pick the "Today" quick-pick from inside the picker. The popover carries
    // an aria-label so the assertion doesn't collide with the sidebar's Today
    // smart-view button (same accessible name, different element).
    const picker = app.getByRole("dialog", { name: "Schedule picker" });
    await expect(picker).toBeVisible();
    await picker.getByRole("button", { name: "Today", exact: true }).click();

    // Byline chip flipped to a "Scheduled:" state — proves the schedule
    // committed even with the popover still open.
    await expect(app.getByRole("button", { name: /^Scheduled:/ })).toBeVisible();

    // Page now surfaces in Today smart view (the schedule round-tripped).
    // Scope to the sidebar — the schedule picker also has a "Today" button
    // and may still be mounted.
    const sidebar = app.getByRole("group", { name: "Views and folders" });
    await sidebar.getByRole("button", { name: /^Today/ }).click();
    await expect(
      app.locator("[data-page-list-item]").filter({ hasText: "field research" })
    ).toBeVisible();
  }
);

// ─── Clear schedule via byline → page leaves Today ──────────────────────────

appTest(
  "clearing schedule via byline removes the page from Today @tier2",
  async ({ app }) => {
    // Seed a page that's already scheduled for today via Quick Add.
    await quickAdd(app, "lunch today");

    // Page is in Today.
    await app.getByRole("button", { name: /^Today/ }).click();
    const item = app.locator("[data-page-list-item]").filter({ hasText: "lunch" });
    await expect(item).toBeVisible();

    // Open the editor — Today view does not auto-open the editor on click of
    // the page item (sidebar nav button click), so click the list item to
    // activate it.
    await item.click();
    // Wait for the byline to mount.
    await expect(app.getByRole("button", { name: "Mark done" })).toBeVisible();

    // Open the date picker via the existing schedule chip and click Clear.
    await app.getByRole("button", { name: /^Scheduled:/ }).click();
    const picker = app.getByRole("dialog", { name: "Schedule picker" });
    await picker.getByRole("button", { name: "Clear", exact: true }).click();

    // Chip flips back to the unset state.
    await app.keyboard.press(mod("Mod+w")); // close active page so list refreshes
    await expect(app.getByRole("button", { name: "Set schedule" })).not.toBeVisible();

    // Today no longer shows the page — the schedule was actually cleared,
    // not just visually hidden.
    await expect(item).not.toBeVisible();

    // The page does still exist (in Inbox) — clearing the schedule mustn't
    // delete the page itself.
    await app.getByRole("button", { name: /^Inbox/ }).click();
    await expect(
      app.locator("[data-page-list-item]").filter({ hasText: "lunch" })
    ).toBeVisible();
  }
);
