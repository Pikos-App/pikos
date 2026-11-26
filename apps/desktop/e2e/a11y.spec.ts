// Runtime axe-core audit of the key surfaces: zero serious/critical violations.
// Suppressed rules: scrollable-region-focusable (scrollers lack roving tabindex), and
// aria-required-children (the rule wants role=option direct children, but @tanstack/virtual
// wraps each row in a positioning <div>).

import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";

import { test as appTest, expect, mod, quickAdd } from "./fixtures";

const SUPPRESSED_RULES = ["scrollable-region-focusable", "aria-required-children"];

async function scan(app: Page, label: string) {
  // axe reads composited colors, so scanning mid-fade (Radix fade-ins, slow CI) reports
  // transient color-contrast violations. finish() snaps animations to their end state.
  await app.evaluate(() => {
    for (const anim of document.getAnimations()) {
      try {
        anim.finish();
      } catch {
        // Infinite animations throw on finish(); leave them.
      }
    }
  });

  const results = await new AxeBuilder({ page: app })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"])
    .disableRules(SUPPRESSED_RULES)
    // Tailwind's `sr-only` lacks the `clip` axe looks for, so axe flags screen-reader-only text for contrast.
    .exclude(".sr-only")
    .analyze();

  const blocking = results.violations.filter(
    (v) => v.impact === "serious" || v.impact === "critical"
  );

  if (blocking.length > 0) {
    const summary = blocking
      .map(
        (v) =>
          `  • ${v.id} (${v.impact}): ${v.help}\n    ${v.nodes
            .slice(0, 3)
            .map((n) => n.target.join(" "))
            .join("\n    ")}`
      )
      .join("\n");
    throw new Error(`axe found ${blocking.length} blocking violation(s) on ${label}:\n${summary}`);
  }
}

appTest("a11y: empty workspace", async ({ app }) => {
  await scan(app, "empty workspace");
});

appTest("a11y: page editor", async ({ app }) => {
  await quickAdd(app, "axe scan target");
  await app.locator("[data-page-list-item]").getByText("axe scan target").click();
  await expect(app.getByRole("textbox", { name: "Page content" })).toBeVisible();
  await scan(app, "page editor");
});

appTest("a11y: calendar view", async ({ app }) => {
  await quickAdd(app, "calendar scan @today");
  await app.keyboard.press(mod("Mod+Shift+c"));
  await expect(app.getByRole("region", { name: "Week calendar" })).toBeVisible();
  await scan(app, "calendar view");
});

appTest("a11y: quick add dialog", async ({ app }) => {
  await app.keyboard.press(mod("Mod+n"));
  await expect(app.getByRole("dialog", { name: "Quick add" })).toBeVisible();
  await scan(app, "quick add dialog");
});

appTest("a11y: search palette", async ({ app }) => {
  await quickAdd(app, "palette scan");
  await app.keyboard.press(mod("Mod+k"));
  await expect(app.getByRole("dialog", { name: "Search pages" })).toBeVisible();
  await app.keyboard.type("palette");
  // Wait for the FTS debounce so results render before the scan.
  await expect(app.getByRole("dialog").getByText("palette scan")).toBeVisible();
  await scan(app, "search palette");
});

appTest("a11y: settings dialog", async ({ app }) => {
  await app.keyboard.press(mod("Mod+,"));
  await expect(app.getByRole("region", { name: "Settings" })).toBeVisible();
  await scan(app, "settings dialog");
});

appTest("a11y: slash menu", async ({ app }) => {
  await quickAdd(app, "slash menu scan");
  await app.locator("[data-page-list-item]").getByText("slash menu scan").click();
  const editor = app.getByRole("textbox", { name: "Page content" });
  await expect(editor).toBeVisible();
  await editor.focus();
  await app.keyboard.type("/");
  await expect(app.getByRole("listbox", { name: "Slash commands" })).toBeVisible();
  await scan(app, "slash menu");
});
