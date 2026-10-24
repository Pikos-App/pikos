import type { Page } from "@playwright/test";

import {
  test as appTest,
  expect,
  gutterLabel,
  hourLineY,
  mod,
  openCalendarMode,
  quickAdd,
} from "./fixtures";

async function openInEditor(app: Page, title: string) {
  await app.getByRole("button", { name: "Editor view" }).click();
  await app.locator("[data-page-list-item]").filter({ hasText: title }).click();
}

/** Open a page's date picker from its byline. */
async function openPicker(app: Page, title: string) {
  await openInEditor(app, title);
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
  "removing a time keeps the dates as all-day, and a time typed on an all-day span collapses it",
  { tag: ["@SCHED-05"] },
  async ({ app }) => {
    const chip = app.getByRole("button", { name: /^Scheduled: / });

    await appTest.step("SCHED-05 a timed page over midnight becomes an all-day span", async () => {
      await quickAdd(app, "server shift today 9pm to 5am");
      await openInEditor(app, "server shift");
      await app.getByRole("button", { name: "Remove time" }).click();
      await expect(chip).toHaveAccessibleName(/^Scheduled: \w{3} \d+ – (\w{3} )?\d+$/);
      await expect(app.getByRole("button", { name: /^Time: / })).toHaveCount(0);
    });

    await appTest.step("SCHED-05 an all-day span given a time collapses to one day", async () => {
      await quickAdd(app, "summit from Mon to Wed");
      await openInEditor(app, "summit");
      await expect(chip).toHaveAccessibleName(/–/);
      await app.getByRole("textbox", { name: "Type a time" }).fill("9am");
      await app.keyboard.press("Enter");
      await expect(chip).toHaveAccessibleName(/9:00am/);
      await expect(chip).not.toHaveAccessibleName(/–/);
    });
  }
);

appTest(
  "Next week in the byline's date picker picks the coming Monday and keeps the time set",
  { tag: ["@SCHED-06:2"] },
  async ({ app }) => {
    await quickAdd(app, "dentist today 3pm");
    const picker = await openPicker(app, "dentist");
    await picker.getByRole("button", { exact: true, name: "Next week" }).click();
    await app.keyboard.press("Escape");
    await expect(picker).not.toBeVisible();

    const comingMonday = await app.evaluate(() => {
      const d = new Date();
      d.setDate(d.getDate() + ((8 - d.getDay()) % 7 || 7));
      const month = d.toLocaleDateString("en-US", { month: "long" });
      return `All-day events, Monday ${month} ${d.getDate()}`;
    });

    await appTest.step("SCHED-06 the page sits on the coming Monday at 3 PM", async () => {
      await openCalendarMode(app);
      const calendar = app.getByRole("region", { name: "Week calendar" });
      const column = calendar.getByLabel(comingMonday, { exact: true });
      if ((await column.count()) === 0) {
        await app.getByRole("button", { exact: true, name: "Next week" }).click();
      }
      await gutterLabel(app, 15).scrollIntoViewIfNeeded();
      const block = calendar.getByRole("button", { name: /^dentist, 3/ });
      await expect(block).toHaveCount(1);
      const blockBox = await block.boundingBox();
      const columnBox = await column.boundingBox();
      if (!blockBox || !columnBox) throw new Error("no block or no Monday column");
      const x = blockBox.x + blockBox.width / 2;
      expect(x).toBeGreaterThan(columnBox.x);
      expect(x).toBeLessThan(columnBox.x + columnBox.width);
      expect(Math.abs(blockBox.y - (await hourLineY(app, 15)))).toBeLessThan(4);
    });
  }
);

appTest(
  "the date picker's presets and any day move the page and keep its time and length",
  { tag: ["@SCHED-07"] },
  async ({ app }) => {
    await quickAdd(app, "review today 3pm for 30m");
    const picker = await openPicker(app, "review");
    const chip = app.getByRole("button", { name: /^Scheduled: / });
    const time = app.getByRole("button", { name: /^Time: / });

    await appTest.step("SCHED-07 Tomorrow, then +1 day, keep 3 to 3:30", async () => {
      await picker.getByRole("button", { exact: true, name: "Tomorrow" }).click();
      await expect(chip).toHaveAccessibleName(/^Scheduled: Tomorrow 3:00pm/);
      await picker.getByRole("button", { exact: true, name: "+1 day" }).click();
      await expect(chip).not.toHaveAccessibleName(/Tomorrow|Today/);
      await expect(time).toHaveAccessibleName("Time: 3:00pm–3:30pm");
    });

    await appTest.step("SCHED-07 Today brings it back, and No date clears it", async () => {
      await picker.getByRole("button", { exact: true, name: "Today" }).click();
      await expect(chip).toHaveAccessibleName(/^Scheduled: Today 3:00pm/);
      await picker.getByRole("button", { exact: true, name: "No date" }).click();
      await app.keyboard.press(mod("Mod+w"));
      await openInEditor(app, "review");
      await expect(app.getByRole("button", { name: "Set schedule" })).toBeVisible();
      await expect(time).toHaveCount(0);
    });
  }
);

appTest(
  "an all-day page shows no time until one is typed, and a typed time sets the minute and length",
  { tag: ["@SCHED-08"] },
  async ({ app }) => {
    await quickAdd(app, "call the bank today");
    await openInEditor(app, "call the bank");
    const field = app.getByRole("textbox", { name: "Type a time" });
    const time = app.getByRole("button", { name: /^Time: / });

    await appTest.step("SCHED-08 the all-day page shows its date and no time", async () => {
      await expect(app.getByRole("button", { name: "Scheduled: Today" })).toBeVisible();
      await expect(time).toHaveCount(0);
    });

    await appTest.step("SCHED-08 9:05 sets the time to the minute", async () => {
      await field.fill("9:05");
      await app.keyboard.press("Enter");
      await expect(time).toHaveAccessibleName("Time: 9:05am");
    });

    await appTest.step("SCHED-08 3pm for 45m sets the time and the length", async () => {
      await field.fill("3pm for 45m");
      await app.keyboard.press("Enter");
      await expect(time).toHaveAccessibleName("Time: 3:00pm–3:45pm");
      await expect(field).toHaveValue("");
    });

    await appTest.step("SCHED-08 words it can't read stay in the field, unapplied", async () => {
      await field.fill("sometime soon");
      await app.keyboard.press("Enter");
      await expect(field).toHaveAttribute("aria-invalid", "true");
      await expect(time).toHaveAccessibleName("Time: 3:00pm–3:45pm");
    });
  }
);

appTest(
  "the byline's time shows the page on the calendar, where it is moved",
  { tag: ["@SCHED-09"] },
  async ({ app }) => {
    await quickAdd(app, "Budget review today 8pm");
    await openCalendarMode(app);
    const calendar = app.getByRole("region", { name: "Week calendar" });
    const block = calendar.getByRole("button", { name: /^Budget review, 8/ });
    await gutterLabel(app, 7).evaluate((label) => label.scrollIntoView({ block: "start" }));
    await expect(block).not.toBeInViewport();

    await appTest.step("SCHED-09 clicking the time brings the page's block into view", async () => {
      await openInEditor(app, "Budget review");
      await app.getByRole("button", { name: "Time: 8:00pm" }).click();
      await expect(calendar).toBeVisible();
      await expect(block).toBeInViewport();
    });
  }
);
