import type { Locator, Page } from "@playwright/test";
import { addDays, addMonths, format, parse } from "date-fns";

import {
  test as appTest,
  expect,
  gutterLabel,
  hourLineY,
  mod,
  openCalendarMode,
  quickAdd,
  WRITE_QUEUE_DEBOUNCE_MS,
} from "./fixtures";

function calendarOf(app: Page) {
  return app.getByRole("region", { name: "Week calendar" });
}

function allDayCells(app: Page) {
  return calendarOf(app).getByLabel(/^All-day events,/);
}

async function centerX(locator: Locator) {
  const box = await locator.boundingBox();
  if (!box) throw new Error("no box to aim at");
  return box.x + box.width / 2;
}

/** A few pixels under the line lands in the hour's first quarter at every density. */
const INTO_THE_HOUR = 6;

/** A drag's release eats any click this soon after it (see `eatNextClick`). */
const CLICK_EATEN_AFTER_RELEASE_MS = 200;

async function nameTitle(app: Page, title: string) {
  const titleInput = app.getByPlaceholder("Untitled");
  await expect(titleInput).toBeFocused();
  await titleInput.fill(title);
  await app.keyboard.press("Enter");
  await expect(titleInput).not.toBeVisible();
}

async function drag(app: Page, from: { x: number; y: number }, to: { x: number; y: number }) {
  await app.mouse.move(from.x, from.y);
  await app.mouse.down();
  await app.mouse.move(from.x, from.y + 16, { steps: 4 });
  await app.mouse.move(to.x, to.y, { steps: 10 });
  await app.mouse.up();
}

async function choose(app: Page, setting: string, option: string) {
  await app.getByRole("button", { name: "Open settings" }).click();
  const choice = app
    .getByRole("region", { name: "Settings" })
    .getByRole("group", { name: setting })
    .getByRole("button", { exact: true, name: option });
  await choice.click();
  await expect(choice).toHaveAttribute("aria-pressed", "true");
  await app.keyboard.press("Escape");
  await expect(app.getByRole("region", { name: "Settings" })).not.toBeVisible();
}

/** "All-day events, Monday October 5" → "October 5". The year isn't shown, and
 *  reading the weekday back against a guessed year would move the date. */
async function firstDay(app: Page) {
  const label = (await allDayCells(app).first().getAttribute("aria-label")) ?? "";
  return label.split(" ").slice(-2).join(" ");
}

function weekLater(day: string, weeks: number) {
  return format(addDays(parse(day, "MMMM d", new Date()), 7 * weeks), "MMMM d");
}

appTest(
  "the week view shows the all-day strip over a 24-hour grid",
  { tag: ["@CAL-01"] },
  async ({ app }) => {
    await openCalendarMode(app);

    await appTest.step("CAL-01 the all-day strip has a cell for each day", async () => {
      await expect(allDayCells(app)).toHaveCount(7);
    });

    await appTest.step("CAL-01 the grid under it runs all 24 hours", async () => {
      await expect(app.getByLabel("Time grid", { exact: true })).toBeVisible();
      await app.getByRole("button", { name: "Expand 12 AM to 6 AM" }).click();
      await app.getByRole("button", { name: "Expand 10 PM to 12 AM" }).click();
      for (let hour = 1; hour < 24; hour++) await expect(gutterLabel(app, hour)).toBeAttached();
    });
  }
);

appTest(
  "dragging across empty time slots creates a page for that span",
  { tag: ["@CAL-02"] },
  async ({ app }) => {
    await openCalendarMode(app);

    await appTest.step("CAL-02 a drag from 9 to 11 AM creates a 9 to 11 page", async () => {
      // The grid opens scrolled to now, so after midday 9 AM starts above the view.
      await gutterLabel(app, 9).scrollIntoViewIfNeeded();
      const x = await centerX(allDayCells(app).last());
      await drag(
        app,
        { x, y: (await hourLineY(app, 9)) + INTO_THE_HOUR },
        { x, y: (await hourLineY(app, 11)) + INTO_THE_HOUR }
      );
      await nameTitle(app, "Deep work");
      await expect(calendarOf(app).getByRole("button", { name: /^Deep work, 9–11/ })).toHaveCount(
        1
      );
    });
  }
);

appTest(
  "clicking a time slot creates a page at that time and opens its popover",
  { tag: ["@CAL-03"] },
  async ({ app }) => {
    await openCalendarMode(app);

    await appTest.step("CAL-03 a click at 2 PM opens the popover on a new page", async () => {
      await gutterLabel(app, 14).scrollIntoViewIfNeeded();
      await app.mouse.click(
        await centerX(allDayCells(app).last()),
        (await hourLineY(app, 14)) + INTO_THE_HOUR
      );
      await expect(app.getByPlaceholder("Untitled")).toBeFocused();
    });

    await appTest.step("CAL-03 the page is at the clicked time", async () => {
      await nameTitle(app, "Call the bank");
      await expect(calendarOf(app).getByRole("button", { name: /^Call the bank, 2–/ })).toHaveCount(
        1
      );
    });
  }
);

appTest(
  "a page dragged from the list onto a time slot is scheduled there",
  { tag: ["@CAL-05"] },
  async ({ app }) => {
    await quickAdd(app, "Draft the brief");
    await openCalendarMode(app);
    const column = allDayCells(app).last();

    await appTest.step("CAL-05 dropping on 9 AM schedules the page at 9 AM that day", async () => {
      await gutterLabel(app, 9).scrollIntoViewIfNeeded();
      const item = app.locator("[data-page-list-item]").filter({ hasText: "Draft the brief" });
      const itemBox = await item.boundingBox();
      if (!itemBox) throw new Error("no list row");
      await drag(
        app,
        { x: itemBox.x + itemBox.width / 2, y: itemBox.y + itemBox.height / 2 },
        { x: await centerX(column), y: (await hourLineY(app, 9)) + INTO_THE_HOUR }
      );

      const block = calendarOf(app).getByRole("button", { name: /^Draft the brief, 9–/ });
      await expect(block).toHaveCount(1);
      const blockX = await centerX(block);
      const columnBox = await column.boundingBox();
      if (!columnBox) throw new Error("no column");
      expect(blockX).toBeGreaterThan(columnBox.x);
      expect(blockX).toBeLessThan(columnBox.x + columnBox.width);
    });
  }
);

appTest(
  "a timed block resizes and takes an inline title edit, and both stick",
  { tag: ["@CAL-06"] },
  async ({ app, storage }) => {
    appTest.skip(
      storage !== "bridge",
      "CAL-06 reloads, and the mock keeps nothing across a reload"
    );
    await openCalendarMode(app);
    const calendar = calendarOf(app);

    await gutterLabel(app, 16).scrollIntoViewIfNeeded();
    await app.mouse.click(
      await centerX(allDayCells(app).last()),
      (await hourLineY(app, 14)) + INTO_THE_HOUR
    );
    await nameTitle(app, "Review");

    await appTest.step("CAL-06 dragging the bottom edge to 4 PM makes it run 2 to 4", async () => {
      const block = calendar.getByRole("button", { name: /^Review, 2/ });
      const box = await block.boundingBox();
      if (!box) throw new Error("no block");
      const x = box.x + box.width / 2;
      await app.mouse.move(x, box.y + box.height - 2);
      await app.mouse.down();
      await app.mouse.move(x, (await hourLineY(app, 16)) + 2, { steps: 10 });
      await app.mouse.up();
      await expect(calendar.getByRole("button", { name: /^Review, 2–4 PM$/ })).toHaveCount(1);
    });

    await appTest.step("CAL-06 a title edited in the block's popover renames it", async () => {
      await app.waitForTimeout(2 * CLICK_EATEN_AFTER_RELEASE_MS);
      await calendar.getByRole("button", { name: /^Review, / }).click();
      const titleInput = app.getByPlaceholder("Untitled");
      await expect(titleInput).toHaveValue("Review");
      await titleInput.fill("Design review");
      await app.keyboard.press("Enter");
      await expect(calendar.getByRole("button", { name: /^Design review, 2–4 PM$/ })).toHaveCount(
        1
      );
    });

    await appTest.step("CAL-06 after a relaunch both the length and the title stick", async () => {
      await app.waitForTimeout(2 * WRITE_QUEUE_DEBOUNCE_MS);
      await app.reload();
      await openCalendarMode(app);
      await expect(calendar.getByRole("button", { name: /^Design review, 2–4 PM$/ })).toHaveCount(
        1
      );
    });
  }
);

appTest(
  "View in calendar scrolls the page's hour into view",
  { tag: ["@CAL-07"] },
  async ({ app }) => {
    await quickAdd(app, "Budget review today 8pm");
    await openCalendarMode(app);
    const block = calendarOf(app).getByRole("button", { name: /^Budget review, 8/ });

    // A saved morning position, so a plain reveal would land away from the evening.
    await gutterLabel(app, 7).evaluate((label) => label.scrollIntoView({ block: "start" }));
    await expect(block).not.toBeInViewport();

    await appTest.step("CAL-07 View in calendar brings 8 PM into view", async () => {
      await app.getByRole("button", { name: "Editor view" }).click();
      await app.locator("[data-page-list-item]").filter({ hasText: "Budget review" }).click();
      await app.getByRole("button", { name: "View in calendar" }).click();
      await expect(calendarOf(app)).toBeVisible();
      await expect(block).toBeInViewport();
    });
  }
);

appTest(
  "month view leads chips with the title, folds the rest into +N more, and returns to the grid",
  { tag: ["@CAL-09"] },
  async ({ app }) => {
    for (const [title, time] of [
      ["Alpha sync", "9am"],
      ["Bravo sync", "10am"],
      ["Charlie sync", "11am"],
      ["Delta sync", "1pm"],
      ["Echo sync", "2pm"],
    ]) {
      await quickAdd(app, `${title} today ${time}`);
    }
    await openCalendarMode(app);
    const month = app.getByRole("region", { name: "Month calendar" });

    await appTest.step("CAL-09 m opens month view, its chips leading with the title", async () => {
      await app.keyboard.press("m");
      await expect(month).toBeVisible();
      await expect(month.getByRole("button", { name: /^Alpha sync / })).toHaveText(/^Alpha sync/);
    });

    await appTest.step("CAL-09 +N more opens the day in the time grid", async () => {
      await month.getByRole("button", { name: "+2 more" }).click();
      await expect(month).toHaveCount(0);
      await expect(calendarOf(app).getByRole("button", { name: /^Echo sync, / })).toHaveCount(1);
    });

    await appTest.step(
      "CAL-09 the toolbar opens month view and a day returns to the grid",
      async () => {
        await app.getByRole("button", { name: "Month view" }).click();
        await expect(month).toBeVisible();
        await month
          .getByRole("button", { name: /^Go to / })
          .first()
          .click();
        await expect(calendarOf(app)).toBeVisible();
        await expect(month).toHaveCount(0);
      }
    );

    await appTest.step("CAL-09 month view never widens the window", async () => {
      await app.getByRole("button", { name: "Month view" }).click();
      await app.setViewportSize({ height: 800, width: 1000 });
      await expect(month).toBeVisible();
      await expect
        .poll(() =>
          app.evaluate(
            () => document.documentElement.scrollWidth - document.documentElement.clientWidth
          )
        )
        .toBe(0);
    });
  }
);

appTest(
  "the early and late hours fold into bands that expand, move, hide events and survive reload",
  { tag: ["@CAL-11"] },
  async ({ app }) => {
    await openCalendarMode(app);
    const calendar = calendarOf(app);
    const expandTop = app.getByRole("button", { name: "Expand 12 AM to 6 AM" });
    const collapseTop = app.getByRole("button", { name: "Collapse 12 AM to 6 AM" });

    await appTest.step("CAL-11 both bands start folded at 6 AM and 10 PM", async () => {
      await expect(expandTop).toBeVisible();
      await expect(app.getByRole("button", { name: "Expand 10 PM to 12 AM" })).toBeVisible();
    });

    await appTest.step("CAL-11 a click expands a band and its chevron folds it", async () => {
      await expandTop.click();
      await expect(collapseTop).toBeVisible();
      await collapseTop.click();
      await expect(expandTop).toBeVisible();
    });

    await appTest.step("CAL-11 an event inside a folded band shows as +N more", async () => {
      await expandTop.click();
      await app.getByLabel("Time grid", { exact: true }).evaluate((grid) => {
        grid.scrollTop = 0;
      });
      await app.mouse.click(
        await centerX(allDayCells(app).last()),
        (await hourLineY(app, 1)) + INTO_THE_HOUR
      );
      await nameTitle(app, "Early bird");
      await collapseTop.click();
      await calendar
        .getByRole("button", { name: /^\d+ more events?$/ })
        .first()
        .click();
      await expect(app.getByRole("button", { name: /^Early bird/ }).first()).toBeVisible();
      await app.keyboard.press("Escape");
    });

    let topName = "";
    let bottomName = "";

    await appTest.step("CAL-11 dragging the top boundary moves the band's hour", async () => {
      await expandTop.click();
      const handle = app.getByRole("separator", { name: "Adjust top collapse boundary" });
      await handle.scrollIntoViewIfNeeded();
      const box = await handle.boundingBox();
      if (!box) throw new Error("no top boundary");
      await drag(
        app,
        { x: box.x + box.width / 2, y: box.y + box.height / 2 },
        { x: box.x + box.width / 2, y: box.y + 240 }
      );
      const moved = app.getByRole("button", { name: /^Collapse 12 AM to (?!6 AM)\d/ });
      await expect(moved).toBeVisible();
      topName = (await moved.getAttribute("aria-label")) ?? "";
    });

    await appTest.step("CAL-11 dragging the bottom boundary moves the band's hour", async () => {
      await app.getByRole("button", { name: "Expand 10 PM to 12 AM" }).click();
      const handle = app.getByRole("separator", { name: "Adjust bottom collapse boundary" });
      await handle.scrollIntoViewIfNeeded();
      const box = await handle.boundingBox();
      if (!box) throw new Error("no bottom boundary");
      await drag(
        app,
        { x: box.x + box.width / 2, y: box.y + box.height / 2 },
        { x: box.x + box.width / 2, y: box.y - 240 }
      );
      const moved = app.getByRole("button", { name: /^Collapse (?!10 PM)\d+ [AP]M to 12 AM$/ });
      await expect(moved).toBeVisible();
      bottomName = (await moved.getAttribute("aria-label")) ?? "";
    });

    await appTest.step("CAL-11 after a reload both bands keep their state and hour", async () => {
      await app.reload();
      await openCalendarMode(app);
      await expect(app.getByRole("button", { name: topName })).toBeVisible();
      await expect(app.getByRole("button", { name: bottomName })).toBeVisible();
    });
  }
);

appTest(
  "previous, next, arrows, Today, t and m page by week or month and jump back",
  { tag: ["@CAL-12"] },
  async ({ app }) => {
    await openCalendarMode(app);
    const today = await firstDay(app);
    const jumpToWeek = app.getByRole("button", { name: "Jump to current week" });

    await appTest.step("CAL-12 Next and Previous page one week", async () => {
      await app.getByRole("button", { exact: true, name: "Next week" }).click();
      await expect.poll(() => firstDay(app)).toBe(weekLater(today, 1));
      await app.getByRole("button", { exact: true, name: "Previous week" }).click();
      await expect.poll(() => firstDay(app)).toBe(today);
    });

    await appTest.step("CAL-12 the Right and Left arrows page one week", async () => {
      await app.keyboard.press("ArrowRight");
      await expect.poll(() => firstDay(app)).toBe(weekLater(today, 1));
      await app.keyboard.press("ArrowLeft");
      await app.keyboard.press("ArrowLeft");
      await expect.poll(() => firstDay(app)).toBe(weekLater(today, -1));
    });

    await appTest.step("CAL-12 the Today button and t return to this week", async () => {
      await expect(jumpToWeek).toBeEnabled();
      await jumpToWeek.click();
      await expect.poll(() => firstDay(app)).toBe(today);
      await expect(jumpToWeek).toBeDisabled();
      await app.keyboard.press("ArrowRight");
      await app.keyboard.press("t");
      await expect.poll(() => firstDay(app)).toBe(today);
    });

    await appTest.step("CAL-12 in month view the same controls page one month", async () => {
      await app.keyboard.press("m");
      const heading = app.getByRole("heading", { name: "Visible month" });
      const thisMonth = (await heading.textContent()) ?? "";
      const monthLater = (months: number) =>
        format(addMonths(parse(thisMonth, "MMMM yyyy", new Date()), months), "MMMM yyyy");

      await app.getByRole("button", { exact: true, name: "Next month" }).click();
      await expect(heading).toHaveText(monthLater(1));
      await app.keyboard.press("ArrowRight");
      await expect(heading).toHaveText(monthLater(2));
      await app.keyboard.press("ArrowLeft");
      await app.getByRole("button", { exact: true, name: "Previous month" }).click();
      await expect(heading).toHaveText(monthLater(0));
      await app.keyboard.press("ArrowLeft");
      await app.keyboard.press("t");
      await expect(heading).toHaveText(monthLater(0));

      await app.keyboard.press(mod("Mod+Shift+K"));
      const palette = app.getByRole("dialog", { name: "Search pages" });
      for (const label of ["Previous month", "Next month", "Switch to time grid"]) {
        await expect(palette.getByRole("button", { name: new RegExp(`^${label}`) })).toBeVisible();
      }
      await app.keyboard.press("Escape");
      await expect(palette).not.toBeVisible();
    });

    await appTest.step("CAL-12 m returns to the week grid", async () => {
      await app.keyboard.press("m");
      await expect(calendarOf(app)).toBeVisible();
      await expect.poll(() => firstDay(app)).toBe(today);
    });

    await appTest.step("CAL-12 the keys leave a hidden calendar alone", async () => {
      await app.getByRole("button", { name: "Editor view" }).click();
      await app.getByText("Folders", { exact: true }).click();
      await app.keyboard.press("ArrowRight");
      await app.keyboard.press("m");
      await app.getByRole("button", { name: "Calendar view" }).click();
      await expect(calendarOf(app)).toBeVisible();
      await expect.poll(() => firstDay(app)).toBe(today);
    });
  }
);

appTest(
  "an event spanning weeks continues with its title and checkbox, handles only on real edges",
  { tag: ["@CAL-13"] },
  async ({ app }) => {
    await openCalendarMode(app);
    const chip = calendarOf(app).getByRole("button", { name: "Conference" });
    // The edge handles are pointer-only, with nothing a role or name could expose.
    const startHandle = chip.locator('[data-resize-edge="start"]');
    const endHandle = chip.locator('[data-resize-edge="end"]');

    await allDayCells(app).last().click();
    await nameTitle(app, "Conference");
    await chip.click();
    await app.getByRole("button", { name: /^Scheduled: / }).click();
    await app.getByRole("button", { name: "Ends in 3d" }).click();
    await app.keyboard.press("Escape");
    await app.keyboard.press("Escape");

    await appTest.step(
      "CAL-13 this week's chip has no handle on the side that continues",
      async () => {
        await expect(startHandle).toHaveCount(1);
        await expect(endHandle).toHaveCount(0);
      }
    );

    await appTest.step(
      "CAL-13 next week's continuation carries the title, no handle before it",
      async () => {
        // By label: the date picker's own "Next week" preset is still on screen.
        await app.getByLabel("Next week", { exact: true }).click();
        await expect(chip).toHaveText(/Conference/);
        await expect(startHandle).toHaveCount(0);
        await expect(endHandle).toHaveCount(1);
      }
    );

    await appTest.step("CAL-13 the continuation's checkbox completes the page", async () => {
      const titleBox = await chip.getByText("Conference").boundingBox();
      if (!titleBox) throw new Error("no title on the continuation");
      await app.mouse.click(titleBox.x - 10, titleBox.y + titleBox.height / 2);
      await expect(
        app.locator("[data-page-list-item]").filter({ hasText: "Conference" })
      ).not.toBeVisible();
    });
  }
);

appTest(
  "Week starts on reorders the grid and the date picker",
  { tag: ["@CAL-15"] },
  async ({ app }) => {
    await quickAdd(app, "Dentist");
    const picker = app.getByRole("dialog", { name: "Schedule picker" });

    async function expectWeekStartsOn(day: "Monday" | "Sunday") {
      await openCalendarMode(app);
      await expect(allDayCells(app).first()).toHaveAttribute(
        "aria-label",
        new RegExp(`^All-day events, ${day} `)
      );

      await app.getByRole("button", { name: "Editor view" }).click();
      await app.locator("[data-page-list-item]").filter({ hasText: "Dentist" }).click();
      await app.getByRole("button", { name: "Set schedule" }).click();
      await expect(picker).toBeVisible();
      const monday = await centerX(picker.getByText("Mo", { exact: true }));
      const sunday = await centerX(picker.getByText("Su", { exact: true }));
      expect(day === "Monday" ? monday < sunday : sunday < monday).toBe(true);
      await app.keyboard.press("Escape");
      await expect(picker).not.toBeVisible();
    }

    await appTest.step("CAL-15 Monday leads the grid and the picker", async () => {
      await choose(app, "Week starts on", "Monday");
      await expectWeekStartsOn("Monday");
    });

    await appTest.step("CAL-15 Sunday leads the grid and the picker", async () => {
      await choose(app, "Week starts on", "Sunday");
      await expectWeekStartsOn("Sunday");
    });
  }
);

appTest(
  "every calendar day count renders, and a narrow window demotes 5 and M–F",
  { tag: ["@CAL-17"] },
  async ({ app }) => {
    const cells = allDayCells(app);

    await appTest.step("CAL-17 1, 3, 5 and 7 render that many days", async () => {
      for (const count of [1, 3, 5, 7]) {
        await choose(app, "Calendar days shown", String(count));
        await openCalendarMode(app);
        await expect(cells).toHaveCount(count);
      }
    });

    await appTest.step("CAL-17 M–F renders Monday to Friday", async () => {
      await choose(app, "Calendar days shown", "M–F");
      await openCalendarMode(app);
      await expect(cells).toHaveCount(5);
      await expect(cells.first()).toHaveAttribute("aria-label", /^All-day events, Monday /);
      await expect(cells.last()).toHaveAttribute("aria-label", /^All-day events, Friday /);
    });

    await appTest.step(
      "CAL-17 a narrow window shows 3 of M–F, and widening restores it",
      async () => {
        await app.setViewportSize({ height: 720, width: 700 });
        await expect(cells).toHaveCount(3);
        await app.setViewportSize({ height: 720, width: 1280 });
        await expect(cells).toHaveCount(5);
        await expect(cells.first()).toHaveAttribute("aria-label", /^All-day events, Monday /);
      }
    );

    await appTest.step("CAL-17 a narrow window shows 3 of 5", async () => {
      await choose(app, "Calendar days shown", "5");
      await openCalendarMode(app);
      await app.setViewportSize({ height: 720, width: 700 });
      await expect(cells).toHaveCount(3);
    });
  }
);

appTest("calendar density scales the hour rows", { tag: ["@CAL-18"] }, async ({ app }) => {
  // Short enough that no density stretches its hours to fill the grid.
  await app.setViewportSize({ height: 600, width: 1280 });
  const hourPitch = async () => (await hourLineY(app, 10)) - (await hourLineY(app, 9));
  const pitches: number[] = [];

  for (const density of ["Compact", "Normal", "Spacious"]) {
    await appTest.step(`CAL-18 ${density} sets its own hour height`, async () => {
      await choose(app, "Calendar density", density);
      await openCalendarMode(app);
      pitches.push(await hourPitch());
    });
  }

  await appTest.step("CAL-18 the rows grow from compact to spacious", () => {
    expect(new Set(pitches).size).toBe(3);
    expect(pitches).toEqual([...pitches].sort((a, b) => a - b));
  });
});

appTest(
  "the calendar's scroll position persists, and starts near the current hour",
  { tag: ["@CAL-19"] },
  async ({ app }) => {
    await openCalendarMode(app);
    const grid = app.getByLabel("Time grid", { exact: true });
    const scrollTop = () => grid.evaluate((el) => el.scrollTop);
    const hour = await app.evaluate(() => new Date().getHours());
    const smartStart = Math.max(7, hour - 1);
    const saved = () => app.evaluate(() => localStorage.getItem("pikos:calendarScrollHour"));

    await appTest.step("CAL-19 with nothing saved it opens near the current hour", async () => {
      // The last hour before the folded evening band is as far as the grid scrolls.
      await expect(gutterLabel(app, Math.min(smartStart, 21))).toBeInViewport();
      await expect.poll(saved).not.toBeNull();
    });

    let parked = 0;

    await appTest.step("CAL-19 a scroll survives switching panels", async () => {
      const opened = await saved();
      // Parked far from where a fresh open lands, so a lost position can't pass.
      if (smartStart <= 10) {
        await grid.evaluate((el) => {
          el.scrollTop = el.scrollHeight;
        });
      } else {
        await gutterLabel(app, 8).evaluate((label) => label.scrollIntoView({ block: "start" }));
      }
      parked = await scrollTop();
      await expect.poll(saved).not.toBe(opened);

      await app.getByRole("button", { name: "Editor view" }).click();
      await openCalendarMode(app);
      await expect.poll(async () => Math.abs((await scrollTop()) - parked)).toBeLessThan(2);
    });

    await appTest.step("CAL-19 the scroll survives a relaunch", async () => {
      await app.reload();
      await openCalendarMode(app);
      await expect.poll(async () => Math.abs((await scrollTop()) - parked)).toBeLessThan(2);
    });
  }
);
