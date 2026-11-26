// Export, wipe and import need Tauri APIs the browser harness can't reach, so this covers the
// preferences round-trip: a toggle takes effect at once, persists across reload and reopens selected.

import { test as appTest, expect, mod, quickAdd } from "./fixtures";

appTest("calendar days setting reflects in the calendar and survives reload", async ({ app }) => {
  await app.getByRole("button", { name: "Calendar view" }).click();
  await expect(app.getByRole("region", { name: "Week calendar" })).toBeVisible();
  const allDayCols = app.locator('[aria-label^="All-day events,"]');
  await expect(allDayCols).toHaveCount(7);

  // Scope queries to the Settings region: the sidebar behind the overlay has matching button labels.
  await app.getByRole("button", { name: "Open settings" }).click();
  const settings = app.getByRole("region", { name: "Settings" });
  await expect(settings.getByRole("heading", { name: "Preferences" })).toBeVisible();

  await settings
    .getByLabel("Calendar days shown")
    .getByRole("button", { exact: true, name: "3" })
    .click();

  await app.keyboard.press("Escape");
  await expect(app.getByRole("heading", { name: "Preferences" })).not.toBeVisible();
  await expect(allDayCols).toHaveCount(3);

  await app.reload();
  await expect(app.getByRole("main", { name: "Workspace" })).toBeVisible();
  await expect(app.getByRole("region", { name: "Week calendar" })).toBeVisible();
  await expect(allDayCols).toHaveCount(3);

  // The buttons don't expose aria-pressed, so the visible UI stands in for the selected value.
});

// The shortcut and the Settings row write the same preference, so the round-trip is only
// proved by driving one and reading the other back.

appTest("editor text size steps from the keyboard and survives reload", async ({ app }) => {
  await quickAdd(app, "font size test");
  await app.locator("[data-page-list-item]").getByText("font size test").click();
  const editor = app.getByRole("textbox", { name: "Page content" });
  await editor.click();

  const fontSize = () => editor.evaluate((el) => getComputedStyle(el).fontSize);
  expect(await fontSize()).toBe("14px");

  await app.keyboard.press(mod("Mod+="));
  await expect.poll(fontSize).toBe("16px");
  await app.keyboard.press(mod("Mod+="));
  await expect.poll(fontSize).toBe("18px");
  await app.keyboard.press(mod("Mod+-"));
  await expect.poll(fontSize).toBe("16px");

  // The keys act on the panel on screen, so with the calendar up they must not
  // resize the editor hiding behind it.
  await app.getByRole("button", { name: "Calendar view" }).click();
  await expect(app.getByRole("region", { name: "Week calendar" })).toBeVisible();
  await app.keyboard.press(mod("Mod+="));
  await app.getByRole("button", { name: "Editor view" }).click();
  await expect.poll(fontSize).toBe("16px");

  // The Settings row is the other half of the round-trip: it must be showing
  // what the shortcut wrote, not its own stale copy.
  await app.getByRole("button", { name: "Open settings" }).click();
  const settings = app.getByRole("region", { name: "Settings" });
  await settings.getByRole("button", { name: /^Editor text size:/ }).click();
  // Radix portals the popover outside the settings region.
  await app.getByRole("button", { exact: true, name: "20" }).click();
  await app.keyboard.press("Escape");
  await expect.poll(fontSize).toBe("20px");

  // The mock adapter holds pages in memory, so a reload starts on an empty
  // workspace — the preference is what has to come back, not the page.
  await app.reload();
  await expect(app.getByRole("main", { name: "Workspace" })).toBeVisible();
  await quickAdd(app, "font size after reload");
  await app.locator("[data-page-list-item]").getByText("font size after reload").click();
  await expect.poll(fontSize).toBe("20px");

  await app.keyboard.press(mod("Mod+0"));
  await expect.poll(fontSize).toBe("14px");
});
