import type { Locator, Page } from "@playwright/test";

import {
  test as appTest,
  bridgeCall,
  expect,
  gutterLabel,
  hourLineY,
  mod,
  openCalendarMode,
  quickAdd,
} from "./fixtures";

function calendarOf(app: Page) {
  return app.getByRole("region", { name: "Week calendar" });
}

/** Calendar blocks for a title that carry the repeat glyph: the virtuals. */
function virtualsOf(app: Page, title: string) {
  return calendarOf(app)
    .getByRole("button", { name: new RegExp(`^${title}`) })
    .filter({ has: app.getByLabel("Recurring") });
}

/** The page's own blocks: no repeat glyph, so the head, clones and moved occurrences. */
function realBlocksOf(app: Page, title: string) {
  return calendarOf(app)
    .getByRole("button", { name: new RegExp(`^${title}`) })
    .filter({ hasNot: app.getByLabel("Recurring") });
}

async function nextWeek(app: Page) {
  // By label: an open date picker has a "Next week" preset too.
  await app.getByLabel("Next week", { exact: true }).click();
}

async function thisWeek(app: Page) {
  const jump = app.getByRole("button", { name: "Jump to current week" });
  if (await jump.isEnabled()) await jump.click();
}

function listRows(app: Page, title: string) {
  return app.locator("[data-page-list-item]").filter({ hasText: title });
}

/** Open a page in the editor by its list row. */
async function openInEditor(app: Page, row: Locator) {
  await app.getByRole("button", { name: "Editor view" }).click();
  await row.click();
}

/** A day `offset` from today, as the date picker's day buttons name it. */
function pickerDay(app: Page, offset: number) {
  return app.evaluate((days) => {
    const d = new Date();
    d.setDate(d.getDate() + days);
    return d.toLocaleDateString("en-US", { day: "numeric", month: "long", year: "numeric" });
  }, offset);
}

/** Set the open page's date from its byline picker, keeping any time. A past day
 *  pages the picker back, a future one forward. */
async function setBylineDate(app: Page, dayLabel: string, direction: "back" | "forward" = "forward") {
  await app.getByRole("button", { name: /^Scheduled: / }).click();
  const picker = app.getByRole("dialog", { name: "Schedule picker" });
  const cell = picker.getByRole("button", { exact: true, name: dayLabel });
  const turn = direction === "back" ? "Previous month" : "Next month";
  for (let i = 0; i < 3 && !(await cell.isVisible()); i++) {
    await picker.getByRole("button", { name: turn }).click();
  }
  await cell.click();
  await app.keyboard.press("Escape");
  await expect(picker).not.toBeVisible();
}

async function bylineSchedule(app: Page) {
  return (await app.getByRole("button", { name: /^Scheduled: / }).getAttribute("aria-label")) ?? "";
}

appTest(
  "a weekly series shows virtuals with the repeat glyph and a head with a checkbox",
  { tag: ["@RECUR-01"] },
  async ({ app }) => {
    await quickAdd(app, "review every week");
    await openCalendarMode(app);

    await appTest.step("RECUR-01 next week's occurrence is a virtual with the glyph", async () => {
      await nextWeek(app);
      await expect(virtualsOf(app, "review")).toHaveCount(1);
      await expect(realBlocksOf(app, "review")).toHaveCount(0);
    });

    await appTest.step("RECUR-01 the head carries a checkbox that completes it", async () => {
      await thisWeek(app);
      const head = realBlocksOf(app, "review");
      await expect(head).toHaveCount(1);
      const title = await head.getByText("review").boundingBox();
      if (!title) throw new Error("no head title");
      await app.mouse.click(title.x - 10, title.y + title.height / 2);
      await app.getByRole("button", { exact: true, name: "Completed" }).click();
      await expect(
        listRows(app, "review").getByRole("checkbox", { name: "Mark not done" })
      ).toBeVisible();
    });
  }
);

appTest(
  "completing an on-time or future head clones it done and advances one step, with no dialog",
  { tag: ["@RECUR-02"] },
  async ({ app }) => {
    await quickAdd(app, "water plants every day");
    const head = listRows(app, "water plants").filter({
      has: app.getByRole("checkbox", { name: "Mark done" }),
    });
    await openInEditor(app, head);
    const tomorrow = await pickerDay(app, 1);
    const dayAfter = await pickerDay(app, 2);

    await appTest.step("RECUR-02 an on-time head advances to tomorrow", async () => {
      await expect(app.getByRole("button", { name: "Scheduled: Today" })).toBeVisible();
      await app.getByRole("button", { name: "Mark done" }).click();
      await expect(app.getByRole("alertdialog")).toHaveCount(0);
      await expect(app.getByRole("button", { name: "Scheduled: Tomorrow" })).toBeVisible();
      expect(tomorrow).not.toBe(dayAfter);
    });

    await appTest.step("RECUR-02 a future head advances one more step", async () => {
      await app.getByRole("button", { name: "Mark done" }).click();
      await expect(app.getByRole("alertdialog")).toHaveCount(0);
      await expect(app.getByRole("button", { name: /^Scheduled: / })).not.toHaveAccessibleName(
        /Today|Tomorrow/
      );
    });

    await appTest.step("RECUR-02 each completion left one done clone", async () => {
      await app.getByRole("button", { exact: true, name: "Completed" }).click();
      await expect(
        listRows(app, "water plants").filter({
          has: app.getByRole("checkbox", { name: "Mark not done" }),
        })
      ).toHaveCount(2);
    });
  }
);

appTest(
  "a virtual moved by its popover date or by a resize becomes its own page",
  { tag: ["@RECUR-05"] },
  async ({ app }) => {
    await quickAdd(app, "standup every day at 9am");
    await openCalendarMode(app);
    await nextWeek(app);
    const virtuals = virtualsOf(app, "standup");
    await expect(virtuals.first()).toBeVisible();
    const before = await virtuals.count();

    await appTest.step("RECUR-05 a new time in the popover makes a real page there", async () => {
      await virtuals.first().scrollIntoViewIfNeeded();
      await virtuals.first().click();
      await app.getByRole("button", { name: /^Scheduled: / }).click();
      await app
        .getByRole("dialog", { name: "Schedule picker" })
        .getByRole("option", { exact: true, name: "11:00am" })
        .click();
      await expect(virtuals).toHaveCount(before - 1);
      await expect(realBlocksOf(app, "standup")).toHaveCount(1);
      await expect(realBlocksOf(app, "standup")).toHaveAccessibleName(/^standup, 11/);
    });

    await appTest.step("RECUR-05 resizing a virtual makes a real page of the new length", async () => {
      await app.keyboard.press("Escape");
      const target = virtuals.first();
      await target.scrollIntoViewIfNeeded();
      const box = await target.boundingBox();
      if (!box) throw new Error("no virtual to resize");
      await app.mouse.move(box.x + box.width / 2, box.y + box.height - 2);
      await app.mouse.down();
      await app.mouse.move(box.x + box.width / 2, box.y + box.height + 60, { steps: 10 });
      await app.mouse.up();
      await expect(virtuals).toHaveCount(before - 2);
      await expect(realBlocksOf(app, "standup")).toHaveCount(2);
    });

    await appTest.step("RECUR-05 both are pages in the list, the originals excluded", async () => {
      await app.getByRole("button", { name: "Editor view" }).click();
      await expect(listRows(app, "standup")).toHaveCount(3);
    });
  }
);

appTest(
  "moving, completing and deleting a moved occurrence or a done clone leaves the head alone",
  { tag: ["@RECUR-06"] },
  async ({ app }) => {
    await quickAdd(app, "standup every day at 9am");
    const head = listRows(app, "standup");
    await openInEditor(app, head);
    const headSchedule = await bylineSchedule(app);

    await openCalendarMode(app);
    await nextWeek(app);
    const virtuals = virtualsOf(app, "standup");
    await expect(virtuals.first()).toBeVisible();
    const virtualCount = (await virtuals.count()) - 1;
    await virtuals.first().scrollIntoViewIfNeeded();
    await virtuals.first().click();
    await app.getByRole("button", { name: /^Scheduled: / }).click();
    await app
      .getByRole("dialog", { name: "Schedule picker" })
      .getByRole("option", { exact: true, name: "11:00am" })
      .click();
    await app.keyboard.press("Escape");
    const moved = realBlocksOf(app, "standup");
    await expect(moved).toHaveCount(1);
    await expect(virtuals).toHaveCount(virtualCount);

    async function expectHeadUntouched() {
      await thisWeek(app);
      await app.getByRole("button", { name: "Editor view" }).click();
      const openHead = listRows(app, "standup").first();
      await openHead.click();
      expect(await bylineSchedule(app)).toBe(headSchedule);
      await openCalendarMode(app);
      await nextWeek(app);
      await expect(virtuals).toHaveCount(virtualCount);
    }

    await appTest.step("RECUR-06 moving the moved occurrence leaves the head", async () => {
      await moved.click();
      await app.getByRole("button", { name: /^Scheduled: / }).click();
      await app
        .getByRole("dialog", { name: "Schedule picker" })
        .getByRole("option", { exact: true, name: "1:00pm" })
        .click();
      await app.keyboard.press("Escape");
      await app.keyboard.press("Escape");
      await expect(moved).toHaveAccessibleName(/^standup, 1/);
      await expectHeadUntouched();
    });

    await appTest.step("RECUR-06 completing it leaves the head", async () => {
      const title = await moved.getByText("standup").boundingBox();
      if (!title) throw new Error("no moved block title");
      await app.mouse.click(title.x - 10, title.y + title.height / 2);
      await expectHeadUntouched();
    });

    await appTest.step("RECUR-06 deleting it leaves the head", async () => {
      await moved.click();
      await expect(app.getByPlaceholder("Untitled")).toBeVisible();
      await app.keyboard.press(mod("Mod+Backspace"));
      await expect(moved).toHaveCount(0);
      await expectHeadUntouched();
    });
  }
);

appTest(
  "moving the head forward stops the virtuals before it",
  { tag: ["@RECUR-07"] },
  async ({ app }) => {
    await quickAdd(app, "stretch every day");
    await openInEditor(app, listRows(app, "stretch"));
    await openCalendarMode(app);
    const blocks = calendarOf(app).getByRole("button", { name: /^stretch/ });
    await expect(blocks.first()).toBeVisible();

    await appTest.step("RECUR-07 after an edit a week out, this week has none", async () => {
      await app.getByRole("button", { name: "Editor view" }).click();
      await setBylineDate(app, await pickerDay(app, 7));
      await openCalendarMode(app);
      await thisWeek(app);
      await expect(blocks).toHaveCount(0);
      await nextWeek(app);
      await expect(blocks.first()).toBeVisible();
    });
  }
);

appTest(
  "deleting the head stops the series, keeps clones, and the trash brings it back",
  { tag: ["@RECUR-08"] },
  async ({ app }) => {
    await quickAdd(app, "feed the cat every day");
    const rows = listRows(app, "feed the cat");
    await openInEditor(app, rows);
    await app.getByRole("button", { name: "Mark done" }).click();
    await expect(app.getByRole("button", { name: "Scheduled: Tomorrow" })).toBeVisible();
    const completed = app.getByRole("button", { exact: true, name: "Completed" });
    const clone = rows.filter({ has: app.getByRole("checkbox", { name: "Mark not done" }) });
    const head = rows.filter({ has: app.getByRole("checkbox", { name: "Mark done" }) });

    await appTest.step("RECUR-08 deleting the head takes the series off the calendar", async () => {
      await head.click({ button: "right" });
      await app.getByRole("menuitem", { name: "Delete" }).click();
      await expect(head).toHaveCount(0);
      await openCalendarMode(app);
      await nextWeek(app);
      await expect(virtualsOf(app, "feed the cat")).toHaveCount(0);
    });

    await appTest.step("RECUR-08 the done clone remains as history", async () => {
      await app.getByRole("button", { name: "Editor view" }).click();
      await completed.click();
      await expect(clone).toHaveCount(1);
    });

    await appTest.step("RECUR-08 restoring from Trash brings the series back", async () => {
      const toast = app.getByRole("alert", { name: /feed the cat/ });
      await expect(toast).not.toBeVisible({ timeout: 15_000 });
      await app.getByRole("button", { exact: true, name: "Trash" }).click();
      await app.getByRole("button", { name: "Restore feed the cat" }).click();
      await openCalendarMode(app);
      await thisWeek(app);
      await nextWeek(app);
      await expect(virtualsOf(app, "feed the cat").first()).toBeVisible();
    });
  }
);

appTest(
  "a recurring page's head and clones both show in Today and in search",
  { tag: ["@RECUR-09"] },
  async ({ app }) => {
    await quickAdd(app, "journal every day");
    const rows = listRows(app, "journal");
    await app.getByRole("button", { name: /^Today/ }).click();

    await appTest.step("RECUR-09 Today shows the head, then its clone once done", async () => {
      await expect(rows).toHaveCount(1);
      await rows.getByRole("checkbox", { name: "Mark done" }).click();
      await app.getByRole("button", { exact: true, name: "Completed" }).click();
      await expect(rows.getByRole("checkbox", { name: "Mark not done" })).toBeVisible();
    });

    await appTest.step("RECUR-09 search lists both, under the same title", async () => {
      await app.keyboard.press(mod("Mod+k"));
      const palette = app.getByRole("dialog", { name: "Search pages" });
      await palette.getByPlaceholder("Search pages, or > for commands…").fill("journal");
      await palette.getByRole("button", { name: /Show completed/i }).click();
      // A result's name runs on into its date, and the clone's into "Completed".
      await expect(palette.getByRole("button", { name: /^journal / })).toHaveCount(2);
    });
  }
);

appTest(
  "the monthly weekday preset reads the date's position, stays checked, and lands on it",
  { tag: ["@RECUR-12"] },
  async ({ app }) => {
    // Next month's 15th and its last day: a cardinal position and a "last" one.
    const dates = await app.evaluate(() => {
      const now = new Date();
      const describe = (d: Date) => {
        const ordinal = d.getDate() + 7 > new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()
          ? "last"
          : ["1st", "2nd", "3rd", "4th", "5th"][Math.ceil(d.getDate() / 7) - 1]!;
        const weekday = d.toLocaleDateString("en-US", { weekday: "short" });
        // The same position two months on, where the series must land.
        const later = new Date(d.getFullYear(), d.getMonth() + 2, 1);
        const days: Date[] = [];
        const monthEnd = new Date(later.getFullYear(), later.getMonth() + 1, 0).getDate();
        for (let i = 1; i <= monthEnd; i++) {
          const c = new Date(later.getFullYear(), later.getMonth(), i);
          if (c.getDay() === d.getDay()) days.push(c);
        }
        const landing = ordinal === "last" ? days[days.length - 1]! : days[Math.ceil(d.getDate() / 7) - 1]!;
        return {
          cell: `Go to ${landing.toLocaleDateString("en-US", { weekday: "long" })} ${landing.toLocaleDateString("en-US", { month: "long" })} ${landing.getDate()}, ${landing.getFullYear()}`,
          detail: `${ordinal} ${weekday}`,
          picker: d.toLocaleDateString("en-US", { day: "numeric", month: "long", year: "numeric" }),
        };
      };
      const mid = new Date(now.getFullYear(), now.getMonth() + 1, 15);
      const last = new Date(now.getFullYear(), now.getMonth() + 2, 0);
      return [describe(mid), describe(last)];
    });

    for (const [i, date] of dates.entries()) {
      const title = `board meeting ${i + 1}`;
      await appTest.step(`RECUR-12 a date on the ${date.detail} offers that preset`, async () => {
        await quickAdd(app, `${title} today`);
        await openInEditor(app, listRows(app, title));
        await setBylineDate(app, date.picker);
        await app.getByRole("button", { name: "Set recurrence" }).click();
        const preset = app.getByRole("button", { exact: true, name: `Monthly, ${date.detail}` });
        await preset.click();
        await expect(app.getByRole("button", { name: /^Recurrence: / })).toBeVisible();
      });

      await appTest.step(`RECUR-12 reopened, ${date.detail} is still the checked row`, async () => {
        await app.getByRole("button", { name: /^Recurrence: / }).click();
        await expect(
          app.getByRole("button", { exact: true, name: `Monthly, ${date.detail}` })
        ).toHaveAttribute("aria-pressed", "true");
        await app.keyboard.press("Escape");
      });

      await appTest.step(`RECUR-12 two months on it lands on the ${date.detail}`, async () => {
        await openCalendarMode(app);
        await app.getByRole("button", { name: "Month view" }).click();
        const month = app.getByRole("region", { name: "Month calendar" });
        for (let m = 0; m < 3 && !(await month.getByRole("button", { name: date.cell }).isVisible()); m++) {
          await app.getByLabel("Next month", { exact: true }).click();
        }
        const cell = month.getByLabel(date.cell.replace(/^Go to /, "Events on "));
        await expect(cell.getByRole("button", { name: new RegExp(`^${title}`) })).toBeVisible();
        await app.getByRole("button", { name: "Time grid view" }).click();
        await app.getByRole("button", { name: "Editor view" }).click();
      });
    }
  }
);

appTest(
  "the Ends editor offers never, a date and a count, and a finished count closes the series",
  { tag: ["@RECUR-13"] },
  async ({ app }) => {
    await quickAdd(app, "physio exercises every day");
    await openInEditor(app, listRows(app, "physio exercises"));
    const ends = (name: string) => app.getByRole("button", { exact: true, name });

    await appTest.step("RECUR-13 Never, On and After each take the Ends choice", async () => {
      await app.getByRole("button", { name: /^Recurrence: / }).click();
      await expect(ends("Never")).toHaveAttribute("aria-pressed", "true");
      await ends("On").click();
      await expect(ends("On")).toHaveAttribute("aria-pressed", "true");
      await ends("After").click();
      await expect(ends("After")).toHaveAttribute("aria-pressed", "true");
      await app.getByLabel("Occurrence count").fill("2");
      await app.keyboard.press("Enter");
      await app.keyboard.press("Escape");
      await expect(app.getByRole("button", { name: /^Recurrence: .*2 times/i })).toBeVisible();
    });

    await appTest.step("RECUR-13 after the second completion the head is done", async () => {
      await app.getByRole("button", { name: "Mark done" }).click();
      await expect(app.getByRole("button", { name: "Scheduled: Tomorrow" })).toBeVisible();
      await app.getByRole("button", { name: "Mark done" }).click();
      await expect(app.getByRole("button", { name: "Mark not done" })).toBeVisible();
    });

    await appTest.step("RECUR-13 nothing is minted past the count", async () => {
      await openCalendarMode(app);
      await nextWeek(app);
      await expect(virtualsOf(app, "physio exercises")).toHaveCount(0);
    });
  }
);

appTest(
  "an off-rule date snaps to the rule, and a single-day weekly rule realigns to it",
  { tag: ["@RECUR-14"] },
  async ({ app }) => {
    const weekdayIn = (offset: number) =>
      app.evaluate((days) => {
        const d = new Date();
        d.setDate(d.getDate() + days);
        return d.toLocaleDateString("en-US", { weekday: "long" });
      }, offset);

    await appTest.step("RECUR-14 a weekly rule follows its head to a new weekday", async () => {
      await quickAdd(app, `team lunch every ${await weekdayIn(0)}`);
      await openInEditor(app, listRows(app, "team lunch"));
      await setBylineDate(app, await pickerDay(app, 1));
      await expect(app.getByRole("button", { name: "Scheduled: Tomorrow" })).toBeVisible();
      await expect(
        app.getByRole("button", { name: new RegExp(`^Recurrence: every week on ${await weekdayIn(1)}`, "i") })
      ).toBeVisible();
    });

    await appTest.step("RECUR-14 a weekday rule moved to a Saturday snaps off it", async () => {
      await quickAdd(app, "inbox zero every weekday");
      await openInEditor(app, listRows(app, "inbox zero"));
      const offset = await app.evaluate(() => {
        const d = new Date();
        return ((6 - d.getDay() + 7) % 7) + 7;
      });
      await setBylineDate(app, await pickerDay(app, offset));
      const saturday = await app.evaluate((days) => {
        const d = new Date();
        d.setDate(d.getDate() + days);
        return d.toLocaleDateString("en-US", { day: "numeric", month: "short" });
      }, offset);
      await expect(app.getByRole("button", { name: /^Scheduled: / })).not.toHaveAccessibleName(
        new RegExp(saturday)
      );
      await expect(app.getByRole("button", { name: /^Recurrence: every weekday/i })).toBeVisible();
    });
  }
);

appTest(
  "an all-day series spans each occurrence and keeps the span on its clones",
  { tag: ["@RECUR-15"] },
  async ({ app }) => {
    // The week starts Monday and a bar clips at the week's edge, so a head on any
    // later weekday would show its occurrences cut short.
    const toNextMonday = await app.evaluate(() => (8 - new Date().getDay()) % 7 || 7);
    await quickAdd(app, "conference every week");
    await openInEditor(app, listRows(app, "conference"));
    await setBylineDate(app, await pickerDay(app, toNextMonday));
    await app.getByRole("button", { name: /^Scheduled: / }).click();
    await app.getByRole("button", { name: "Ends in 3d" }).click();
    await app.keyboard.press("Escape");
    await expect(app.getByRole("button", { name: /^Scheduled: .* – / })).toBeVisible();
    const columnWidth = async () =>
      (await calendarOf(app).getByLabel(/^All-day events,/).first().boundingBox())?.width ?? 0;

    await appTest.step("RECUR-15 the first occurrence is one bar three days wide", async () => {
      await openCalendarMode(app);
      await nextWeek(app);
      await nextWeek(app);
      const bar = virtualsOf(app, "conference");
      await expect(bar).toHaveCount(1);
      const width = (await bar.boundingBox())?.width ?? 0;
      expect(Math.round(width / (await columnWidth()))).toBe(3);
    });

    await appTest.step("RECUR-15 the completed clone keeps the span", async () => {
      await app.getByRole("button", { name: "Editor view" }).click();
      await app.getByRole("button", { name: "Mark done" }).click();
      await app.getByRole("button", { exact: true, name: "Completed" }).click();
      const clone = listRows(app, "conference").filter({
        has: app.getByRole("checkbox", { name: "Mark not done" }),
      });
      await clone.click();
      await expect(app.getByRole("button", { name: /^Scheduled: .* – / })).toBeVisible();
    });
  }
);

/** A series three days overdue: created today, then dated back from the byline,
 *  which leaves two missed days between it and today. */
async function overdueSeries(app: Page, text: string, title: string) {
  await quickAdd(app, text);
  await openInEditor(app, listRows(app, title));
  await setBylineDate(app, await pickerDay(app, -3), "back");
  await expect(app.getByRole("button", { name: /^Scheduled: / })).not.toHaveAccessibleName(/Today/);
}

const scopeDialog = (app: Page) =>
  app.getByRole("dialog").filter({ hasText: /2 other days are still open/ });

appTest(
  "ticking an overdue head asks scope: just this one, or one done page per missed day",
  { tag: ["@RECUR-03"] },
  async ({ app }) => {
    const doneRows = (title: string) =>
      listRows(app, title).filter({ has: app.getByRole("checkbox", { name: "Mark not done" }) });

    await appTest.step("RECUR-03 Just this one completes one day and leaves the rest open", async () => {
      await overdueSeries(app, "stretch every day", "stretch");
      await app.getByRole("button", { name: "Mark done" }).click();
      await expect(scopeDialog(app)).toBeVisible();
      await scopeDialog(app).getByRole("button", { name: /Just this one/ }).click();
      await expect(scopeDialog(app)).toHaveCount(0);
      await app.getByRole("button", { exact: true, name: "Completed" }).click();
      await expect(doneRows("stretch")).toHaveCount(1);
      await expect(app.getByRole("button", { name: /^Scheduled: / })).not.toHaveAccessibleName(
        /Today/
      );
    });

    await appTest.step("RECUR-03 everything before today marks one done page per day", async () => {
      await overdueSeries(app, "pushups every day", "pushups");
      await app.getByRole("button", { name: "Mark done" }).click();
      await scopeDialog(app).getByRole("button", { name: /This and everything before today/ }).click();
      await expect(scopeDialog(app)).toHaveCount(0);
      await expect(doneRows("pushups")).toHaveCount(3);
      await expect(app.getByRole("button", { name: "Scheduled: Today" })).toBeVisible();
    });
  }
);

appTest(
  "a virtual deletes from its popover or Cmd+Backspace, undoes from the toast, and asks scope when overdue",
  { tag: ["@RECUR-04"] },
  async ({ app }) => {
    await quickAdd(app, "standup every day at 9am");
    await openCalendarMode(app);
    await nextWeek(app);
    const virtuals = virtualsOf(app, "standup");
    await expect(virtuals.first()).toBeVisible();
    const before = await virtuals.count();

    await appTest.step("RECUR-04 the popover's delete removes it, and the toast's Undo restores it", async () => {
      await virtuals.first().scrollIntoViewIfNeeded();
      await virtuals.first().click();
      await app.getByRole("button", { name: "Delete this occurrence" }).click();
      await expect(virtuals).toHaveCount(before - 1);
      const toast = app.getByRole("alert", { name: /Deleted one day of/ });
      await toast.getByRole("button", { name: /Undo/ }).click();
      await expect(virtuals).toHaveCount(before);
    });

    await appTest.step("RECUR-04 Cmd+Backspace in its popover deletes it too", async () => {
      await virtuals.first().click();
      await expect(app.getByRole("button", { name: "Delete this occurrence" })).toBeVisible();
      await app.keyboard.press(mod("Mod+Backspace"));
      await expect(virtuals).toHaveCount(before - 1);
    });

    await appTest.step("RECUR-04 with earlier days open, it asks scope first", async () => {
      await app.getByRole("button", { name: "Editor view" }).click();
      await overdueSeries(app, "journal every day at 9am", "journal");
      await openCalendarMode(app);
      await thisWeek(app);
      const missed = await app.evaluate(() => {
        const d = new Date();
        d.setDate(d.getDate() - 2);
        const part = (o: Intl.DateTimeFormatOptions) => d.toLocaleDateString("en-US", o);
        return `All-day events, ${part({ weekday: "long" })} ${part({ month: "long" })} ${part({ day: "numeric" })}`;
      });
      if ((await calendarOf(app).getByLabel(missed).count()) === 0) {
        await app.getByLabel("Previous week", { exact: true }).click();
      }
      const column = await calendarOf(app).getByLabel(missed).boundingBox();
      if (!column) throw new Error("no column for the missed day");
      const journal = virtualsOf(app, "journal");
      let target: Locator | undefined;
      for (const block of await journal.all()) {
        const box = await block.boundingBox();
        if (box && box.x >= column.x && box.x < column.x + column.width) target = block;
      }
      if (!target) throw new Error("no virtual on the missed day");
      await target.scrollIntoViewIfNeeded();
      await target.click();
      await app.getByRole("button", { name: "Delete this occurrence" }).click();
      await expect(scopeDialog(app)).toBeVisible();
      await scopeDialog(app).getByRole("button", { name: /Just this one/ }).click();
      await expect(target).toHaveCount(0);
    });
  }
);

appTest(
  "a weekly timed series keeps its wall-clock time across the clock change",
  { tag: ["@RECUR-16"] },
  async ({ app }) => {
    // The lane runs in America/New_York; find its next clock change from the browser.
    const change = await app.evaluate(() => {
      const start = new Date();
      start.setHours(12, 0, 0, 0);
      const offset = start.getTimezoneOffset();
      const d = new Date(start);
      for (let i = 1; i < 400; i++) {
        d.setDate(d.getDate() + 1);
        if (d.getTimezoneOffset() !== offset) break;
      }
      const label = (x: Date) =>
        `Go to ${x.toLocaleDateString("en-US", { weekday: "long" })} ${x.toLocaleDateString("en-US", { month: "long" })} ${x.getDate()}, ${x.getFullYear()}`;
      const before = new Date(d);
      before.setDate(before.getDate() - 7);
      return {
        after: label(d),
        before: label(before),
        weekday: d.toLocaleDateString("en-US", { weekday: "long" }),
      };
    });
    await quickAdd(app, `standup every ${change.weekday} at 9am`);
    await openCalendarMode(app);

    async function expectNineOn(goTo: string) {
      await app.getByRole("button", { name: "Month view" }).click();
      const month = app.getByRole("region", { name: "Month calendar" });
      for (let m = 0; m < 13 && !(await month.getByRole("button", { name: goTo }).isVisible()); m++) {
        await app.getByLabel("Next month", { exact: true }).click();
      }
      await month.getByRole("button", { name: goTo }).click();
      const block = calendarOf(app).getByRole("button", { name: /^standup, 9/ });
      await expect(block).toHaveCount(1);
      await gutterLabel(app, 10).scrollIntoViewIfNeeded();
      const box = await block.boundingBox();
      if (!box) throw new Error("no standup block");
      expect(Math.abs(box.y - (await hourLineY(app, 9)))).toBeLessThan(4);
      await app.getByRole("button", { name: "Jump to current week" }).click();
    }

    await appTest.step("RECUR-16 the week before the change it is at 9 AM", async () => {
      await expectNineOn(change.before);
    });

    await appTest.step("RECUR-16 the week of the change it is still at 9 AM", async () => {
      await expectNineOn(change.after);
    });
  }
);

appTest(
  "an imported rule outside the editor renders nowhere, logs why, and is read-only",
  { tag: ["@RECUR-17"] },
  async ({ app, storage }) => {
    appTest.skip(storage !== "bridge", "RECUR-17 reads the writer's log, which the mock has none of");
    const logged = await bridgeCall<string[]>(app, "bridge_log");
    const errors: string[] = [];
    app.on("pageerror", (e) => errors.push(e.message));
    // Aimed at next week's ISO week, so an engine that enumerated it would draw it there.
    const { today, week } = await app.evaluate(() => {
      const d = new Date();
      const pad = (n: number) => String(n).padStart(2, "0");
      const thursday = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 7);
      thursday.setDate(thursday.getDate() + 3 - ((thursday.getDay() + 6) % 7));
      const firstThursday = new Date(thursday.getFullYear(), 0, 4);
      firstThursday.setDate(firstThursday.getDate() + 3 - ((firstThursday.getDay() + 6) % 7));
      return {
        today: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
        week: 1 + Math.round((thursday.getTime() - firstThursday.getTime()) / (7 * 86400000)),
      };
    });
    const csv = `List Name,Title,Status,Start Date,Repeat\nWork,Next week review,0,${today},FREQ=YEARLY;BYWEEKNO=${week};BYDAY=MO,TU,WE,TH,FR`;
    await app.evaluate((text) => {
      (window as unknown as Record<string, unknown>)["__PIKOS_TEST_CSV__"] = text;
    }, csv);
    await app.getByRole("button", { name: "Open settings" }).click();
    await app.getByRole("button", { exact: true, name: "Data" }).click();
    await app.getByRole("button", { name: /Select File/ }).click();
    await app.getByRole("button", { name: "Continue" }).click();
    await app.getByRole("button", { name: /Import 1 page/ }).click();
    await expect(app.getByRole("heading", { name: "Import Preview" })).not.toBeVisible();
    await app.keyboard.press("Escape");
    await app
      .getByRole("group", { name: "Views and folders" })
      .getByRole("button", { exact: true, name: "Work" })
      .click();
    const row = listRows(app, "Next week review");

    await appTest.step("RECUR-17 none of the rule's occurrences render", async () => {
      await openCalendarMode(app);
      await nextWeek(app);
      await expect(calendarOf(app).getByLabel(/^All-day events,/).first()).toBeVisible();
      await expect(calendarOf(app).getByRole("button", { name: /^Next week review/ })).toHaveCount(0);
    });

    await appTest.step("RECUR-17 its recurrence chip opens no editor", async () => {
      await openInEditor(app, row);
      await app.getByRole("button", { name: /^Recurrence: / }).click();
      await expect(app.getByRole("button", { name: /^Daily/ })).toHaveCount(0);
    });

    await appTest.step("RECUR-17 nothing raised an error, and the log says why", async () => {
      await expect(app.getByRole("alert")).toHaveCount(0);
      expect(errors).toEqual([]);
      // What pikos.log would hold: the writer's warning, from this test's import.
      const since = (await bridgeCall<string[]>(app, "bridge_log")).slice(logged.length);
      expect(since.some((line) => line.includes("unsupported rule"))).toBe(true);
    });
  }
);

appTest(
  "unticking a done clone rewinds its day onto the head; a pre-0.4.0 one reopens on its own",
  { tag: ["@RECUR-10"] },
  async ({ app, storage }) => {
    appTest.skip(storage !== "bridge", "RECUR-10 seeds the writer directly and reloads");
    await quickAdd(app, "water plants every day");
    const rows = listRows(app, "water plants");
    const open = rows.filter({ has: app.getByRole("checkbox", { name: "Mark done" }) });
    const done = rows.filter({ has: app.getByRole("checkbox", { name: "Mark not done" }) });
    const completed = app.getByRole("button", { exact: true, name: "Completed" });
    await openInEditor(app, open);
    const headId = (await open.getAttribute("data-page-id")) ?? "";

    await appTest.step("RECUR-10 unticking a clone deletes it and the day returns to the head", async () => {
      await app.getByRole("button", { name: "Mark done" }).click();
      await expect(app.getByRole("button", { name: "Scheduled: Tomorrow" })).toBeVisible();
      await completed.click();
      await done.getByRole("checkbox", { name: "Mark not done" }).click();
      await expect(done).toHaveCount(0);
      await open.click();
      await expect(app.getByRole("button", { name: "Scheduled: Today" })).toBeVisible();
    });

    await appTest.step("RECUR-10 a pre-0.4.0 completion unticks as a plain page", async () => {
      // The pre-0.4.0 shape: the day excluded from the rule and a done copy, with no
      // completed-set row linking the two. Nothing in the app makes one any more.
      const today = await app.evaluate(() => {
        const d = new Date();
        const pad = (n: number) => String(n).padStart(2, "0");
        return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
      });
      const rule = await bridgeCall<{ id: string }>(app, "get_recurrence_rule", { pageId: headId });
      await bridgeCall(app, "add_rule_exdates", { dates: [today], id: rule.id });
      await bridgeCall(app, "create_page", {
        data: {
          completedAt: `${today}T08:00:00`,
          content: "",
          priority: 0,
          scheduledStart: today,
          status: "done",
          tags: [],
          title: "water plants",
        },
      });
      await app.reload();
      await expect(app.getByRole("main", { name: "Workspace" })).toBeVisible();
      await completed.click();
      await expect(done).toHaveCount(1);

      await done.getByRole("checkbox", { name: "Mark not done" }).click();
      // Reopened as a page of its own, and the series keeps today excluded.
      await expect(done).toHaveCount(0);
      await expect(open).toHaveCount(2);
      await app.locator(`[data-page-list-item][data-page-id="${headId}"]`).click();
      await expect(app.getByRole("button", { name: "Scheduled: Tomorrow" })).toBeVisible();
    });
  }
);
