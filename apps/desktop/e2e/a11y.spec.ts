// Runtime a11y audit: scans the key UI surfaces with axe-core and asserts
// zero serious/critical violations. Complements the static jsx-a11y lint
// pass — axe catches contrast, name/role mismatches, label issues, and
// duplicate ARIA ids at runtime that static analysis cannot.
//
// Rules suppressed for now (re-enable when the post-launch a11y backlog lands):
//   • "scrollable-region-focusable" — pending roving-tabindex refactor
//   • "aria-required-children" — virtual-list rows fail this; the rule
//     wants role=option direct children but @tanstack/virtual wraps each
//     item in a positioning <div>. Fix moves with the listbox refactor.
// color-contrast IS enforced (WCAG AA shipped) — see scan()'s animation-settle.

import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";

import { expect, mod, quickAdd, test as appTest } from "./fixtures";

const SUPPRESSED_RULES = ["scrollable-region-focusable", "aria-required-children"];

async function scan(app: Page, label: string) {
  // Settle any in-flight open/close animations (Radix dialog/popover fade-ins)
  // before scanning. axe reads composited colors, so scanning mid-fade — which
  // happens on slower CI machines — reports transient color-contrast violations
  // that don't exist once the element reaches full opacity. finish() snaps each
  // animation to its end state; infinite ones (which can't finish) are ignored.
  await app.evaluate(() => {
    for (const anim of document.getAnimations()) {
      try {
        anim.finish();
      } catch {
        // Infinite/forwards-fill animations throw on finish() — leave them.
      }
    }
  });

  const results = await new AxeBuilder({ page: app })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"])
    .disableRules(SUPPRESSED_RULES)
    // Tailwind v4's `sr-only` utility doesn't use the `clip: rect(0,0,0,0)`
    // property axe-core looks for, so it flags visually-hidden Radix
    // description text for contrast. Exclude — these are screen-reader-only.
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

// ─── Boot / empty workspace ─────────────────────────────────────────────────

appTest("a11y: empty workspace @tier2", async ({ app }) => {
  await scan(app, "empty workspace");
});

// ─── Page editor open ───────────────────────────────────────────────────────

appTest("a11y: page editor @tier2", async ({ app }) => {
  await quickAdd(app, "axe scan target");
  await app.locator("[data-page-list-item]").getByText("axe scan target").click();
  await expect(app.getByRole("textbox", { name: "Page content" })).toBeVisible();
  await scan(app, "page editor");
});

// ─── Calendar view ──────────────────────────────────────────────────────────

appTest("a11y: calendar view @tier2", async ({ app }) => {
  await quickAdd(app, "calendar scan @today");
  await app.keyboard.press(mod("Mod+Shift+c"));
  await expect(app.getByRole("region", { name: "Week calendar" })).toBeVisible();
  await scan(app, "calendar view");
});

// ─── Quick Add dialog ───────────────────────────────────────────────────────

appTest("a11y: quick add dialog @tier2", async ({ app }) => {
  await app.keyboard.press(mod("Mod+n"));
  await expect(app.getByRole("dialog", { name: "Quick add" })).toBeVisible();
  await scan(app, "quick add dialog");
});

// ─── Search palette ─────────────────────────────────────────────────────────

appTest("a11y: search palette @tier2", async ({ app }) => {
  await quickAdd(app, "palette scan");
  await app.keyboard.press(mod("Mod+k"));
  await expect(app.getByRole("dialog", { name: "Search pages" })).toBeVisible();
  await app.keyboard.type("palette");
  // Wait for FTS debounce so results render before scan
  await expect(app.getByRole("dialog").getByText("palette scan")).toBeVisible();
  await scan(app, "search palette");
});

// ─── Settings dialog ────────────────────────────────────────────────────────

appTest("a11y: settings dialog @tier2", async ({ app }) => {
  await app.keyboard.press(mod("Mod+,"));
  await expect(app.getByRole("region", { name: "Settings" })).toBeVisible();
  await scan(app, "settings dialog");
});

// ─── Slash menu (editor command palette) ────────────────────────────────────

appTest("a11y: slash menu @tier2", async ({ app }) => {
  await quickAdd(app, "slash menu scan");
  await app.locator("[data-page-list-item]").getByText("slash menu scan").click();
  const editor = app.getByRole("textbox", { name: "Page content" });
  await expect(editor).toBeVisible();
  await editor.focus();
  await app.keyboard.type("/");
  await expect(app.getByRole("listbox", { name: "Slash commands" })).toBeVisible();
  await scan(app, "slash menu");
});
