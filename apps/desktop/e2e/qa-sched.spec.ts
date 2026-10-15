import type { Page } from "@playwright/test";

import {
  test as appTest,
  expect,
  gutterLabel,
  hourLineY,
  openCalendarMode,
  quickAdd,
} from "./fixtures";

/** Open a page's schedule picker from its byline. */
async function openPicker(app: Page, title: string) {
  await app.getByRole("button", { name: "Editor view" }).click();
  await app.locator("[data-page-list-item]").filter({ hasText: title }).click();
  await app.getByRole("button", { name: /^Scheduled: / }).click();
  const picker = app.getByRole("dialog", { name: "Schedule picker" });
  await expect(picker).toBeVisible();
  return picker;
}

appTest("a date-only page sits in the all-day strip", { tag: ["@SCHED-01"] }, async ({ app }) => {
  await quickAdd(app, "Pay rent today");

  await appTest.step("SCHED-01 it sits in today's all-day strip, not the hour grid", async () => {
    await app.getByRole("button", { name: "Calendar view" }).click();
    const calendar = app.getByRole("region", { name: "Week calendar" });

    // A timed block's name carries its time; an all-day chip's is the title alone.
    const chip = calendar.getByRole("button", { exact: true, name: "Pay rent" });
    await expect(chip).toBeVisible();

    const today = await app.evaluate(() => {
      const now = new Date();
      const part = (options: Intl.DateTimeFormatOptions) =>
        now.toLocaleDateString("en-US", options);
      return `${part({ weekday: "long" })} ${part({ month: "long" })} ${part({ day: "numeric" })}`;
    });
    const strip = await calendar.getByLabel(`All-day events, ${today}`).boundingBox();
    const placed = await chip.boundingBox();
    if (!strip || !placed) throw new Error("today's all-day cell or the chip has no box");
    const x = placed.x + placed.width / 2;
    const y = placed.y + placed.height / 2;
    expect(x).toBeGreaterThan(strip.x);
    expect(x).toBeLessThan(strip.x + strip.width);
    expect(y).toBeGreaterThan(strip.y);
    expect(y).toBeLessThan(strip.y + strip.height);
  });
});

appTest(
  "a start with no end draws from the start, and a start and end spans the range",
  { tag: ["@SCHED-02:2"] },
  async ({ app }) => {
    await quickAdd(app, "focus time today 2pm");
    await quickAdd(app, "workshop today 3pm to 5pm");
    await openCalendarMode(app);
    const calendar = app.getByRole("region", { name: "Week calendar" });
    await gutterLabel(app, 17).scrollIntoViewIfNeeded();
    const near = (a: number, b: number) => expect(Math.abs(a - b)).toBeLessThan(4);

    await appTest.step("SCHED-02 a start-only page's block starts at its time", async () => {
      const box = await calendar.getByRole("button", { name: /^focus time, 2/ }).boundingBox();
      if (!box) throw new Error("no focus time block");
      near(box.y, await hourLineY(app, 14));
    });

    await appTest.step("SCHED-02 a start-and-end page's block spans 3 to 5", async () => {
      const box = await calendar.getByRole("button", { name: "workshop, 3–5 PM" }).boundingBox();
      if (!box) throw new Error("no workshop block");
      near(box.y, await hourLineY(app, 15));
      near(box.y + box.height, await hourLineY(app, 17));
    });
  }
);

appTest(
  "the picker converts timed to all-day keeping the dates, and all-day to timed on one day",
  { tag: ["@SCHED-05"] },
  async ({ app }) => {
    const chip = app.getByRole("button", { name: /^Scheduled: / });

    await appTest.step("SCHED-05 a timed page over midnight becomes an all-day span", async () => {
      await quickAdd(app, "server shift today 9pm to 5am");
      const picker = await openPicker(app, "server shift");
      await picker.getByRole("button", { name: "All day — no specific time" }).click();
      await app.keyboard.press("Escape");
      await expect(chip).toHaveAccessibleName(/^Scheduled: \w{3} \d+ – (\w{3} )?\d+$/);
    });

    await appTest.step("SCHED-05 an all-day span given a time collapses to one day", async () => {
      await quickAdd(app, "summit from Mon to Wed");
      const picker = await openPicker(app, "summit");
      await expect(chip).toHaveAccessibleName(/–/);
      await picker
        .getByRole("listbox", { name: "Select start time" })
        .getByRole("option", { exact: true, name: "9:00am" })
        .click();
      await app.keyboard.press("Escape");
      await expect(chip).toHaveAccessibleName(/9:00am/);
      await expect(chip).not.toHaveAccessibleName(/–/);
    });
  }
);
