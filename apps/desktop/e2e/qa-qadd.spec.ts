import type { Page } from "@playwright/test";

import { test as appTest, expect, mod } from "./fixtures";

function quickAddParts(app: Page) {
  return {
    dialog: app.getByRole("dialog", { name: "Quick add" }),
    input: app.getByRole("textbox", { name: "Quick add input" }),
  };
}

/** Open Quick Add and type, leaving it open so the chips can be read. */
async function typeQuickAdd(app: Page, text: string) {
  const { dialog, input } = quickAddParts(app);
  await app.keyboard.press(mod("Mod+n"));
  await expect(dialog).toBeVisible();
  await input.fill(text);
  return dialog;
}

function row(app: Page, title: string) {
  return app.locator("[data-page-list-item]").filter({ hasText: title });
}

async function openRow(app: Page, title: string) {
  await row(app, title).click();
  await expect(app.getByLabel("Page title")).toHaveText(title);
}

/** The page's reminder menu, open, for reading which leads are checked. */
async function openReminders(app: Page) {
  await app.getByRole("button", { name: "Page reminders" }).click();
  return app.getByRole("menu");
}

appTest(
  "Quick Add files pages by folder chip, ~name and ~inbox",
  { tag: ["@QADD-10"] },
  async ({ app }) => {
    const dialog = app.getByRole("dialog", { name: "Quick add" });
    const input = app.getByRole("textbox", { name: "Quick add input" });
    const sidebar = app.getByRole("group", { name: "Views and folders" });
    const errands = sidebar.getByRole("button", { exact: true, name: "Errands" });
    const row = (title: string) => app.locator("[data-page-list-item]").filter({ hasText: title });

    await appTest.step("QADD-10 the folder chip creates a folder inline", async () => {
      await app.keyboard.press(mod("Mod+n"));
      await input.fill("renew passport");
      await dialog.getByRole("button", { name: "Folder: Inbox" }).click();
      await app.getByPlaceholder(/search or create/i).fill("Errands");
      await app.keyboard.press("Enter");
      await expect(dialog.getByRole("button", { name: "Folder: Errands" })).toBeVisible();
      await app.keyboard.press("Enter");
      await expect(dialog).not.toBeVisible();
      await errands.click();
      await expect(row("renew passport")).toBeVisible();
    });

    await appTest.step("QADD-10 ~name routes to that folder", async () => {
      await app.getByRole("button", { name: /^Inbox/ }).click();
      await app.keyboard.press(mod("Mod+n"));
      await input.fill("buy stamps ~Errands");
      await expect(dialog.getByRole("button", { name: "Folder: Errands" })).toBeVisible({
        timeout: 2000,
      });
      await app.keyboard.press("Enter");
      await expect(dialog).not.toBeVisible();
      await expect(row("buy stamps")).not.toBeVisible();
      await errands.click();
      await expect(row("buy stamps")).toBeVisible();
    });

    await appTest.step("QADD-10 ~inbox routes to Inbox, from inside a folder", async () => {
      await app.keyboard.press(mod("Mod+n"));
      await expect(dialog.getByRole("button", { name: "Folder: Errands" })).toBeVisible();
      await input.fill("dump ~inbox");
      await expect(dialog.getByRole("button", { name: "Folder: Inbox" })).toBeVisible({
        timeout: 2000,
      });
      await app.keyboard.press("Enter");
      await expect(dialog).not.toBeVisible();
      await expect(row("dump")).not.toBeVisible();
      await app.getByRole("button", { name: /^Inbox/ }).click();
      await expect(row("dump")).toBeVisible();
    });
  }
);

appTest(
  "a full sentence gives the right title, date, priority and tag",
  { tag: ["@QADD-01"] },
  async ({ app }) => {
    const dialog = await typeQuickAdd(app, "Call dentist tomorrow !high #health");

    await appTest.step("QADD-01 the chips read the sentence before it's added", async () => {
      await expect(dialog.getByRole("button", { name: /^Scheduled: Tomorrow/ })).toBeVisible();
      await expect(dialog.getByRole("button", { name: "Priority: High" })).toBeVisible();
      await expect(dialog.getByRole("button", { name: "Tags: health" })).toBeVisible();
      await app.keyboard.press("Enter");
      await expect(dialog).not.toBeVisible();
    });

    await appTest.step("QADD-01 the page carries all four", async () => {
      await openRow(app, "Call dentist");
      await expect(app.getByRole("button", { name: /^Scheduled: Tomorrow/ })).toBeVisible();
      await expect(app.getByRole("button", { name: "Priority: High" })).toBeVisible();
      await expect(app.getByRole("button", { name: "Tags: health" })).toBeVisible();
    });
  }
);

appTest("a bare time sets the time", { tag: ["@QADD-02"] }, async ({ app }) => {
  const dialog = await typeQuickAdd(app, "standup 9am");

  await appTest.step("QADD-02 the page is scheduled at 9 AM", async () => {
    await expect(dialog.getByRole("button", { name: /^Scheduled: .*9(:00)?\s?AM/i })).toBeVisible();
    await app.keyboard.press("Enter");
    await openRow(app, "standup");
    await expect(app.getByRole("button", { name: /^Scheduled: .*9(:00)?\s?AM/i })).toBeVisible();
  });
});

appTest(
  "no date, several tags and priority forms parse, and unparsed words stay visible",
  { tag: ["@QADD-03"] },
  async ({ app }) => {
    await appTest.step("QADD-03 no date leaves the page unscheduled", async () => {
      const dialog = await typeQuickAdd(app, "buy milk");
      await expect(dialog.getByRole("button", { name: "Set schedule" })).toBeVisible();
      await app.keyboard.press("Enter");
      await openRow(app, "buy milk");
      await expect(app.getByRole("button", { name: "Set schedule" })).toBeVisible();
    });

    await appTest.step("QADD-03 several tags all land", async () => {
      const dialog = await typeQuickAdd(app, "plan trip #travel #family");
      await expect(
        dialog.getByRole("button", { name: /^Tags: (travel, family|family, travel)$/ })
      ).toBeVisible();
      await app.keyboard.press("Enter");
      await openRow(app, "plan trip");
    });

    await appTest.step("QADD-03 each priority form maps to its level", async () => {
      for (const [text, level] of [
        ["file taxes !urgent", "Urgent"],
        ["renew passport !2", "High"],
        ["water plants !medium", "Medium"],
        ["dust shelves !4", "Low"],
      ] as const) {
        const dialog = await typeQuickAdd(app, text);
        await expect(dialog.getByRole("button", { name: `Priority: ${level}` })).toBeVisible();
        await app.keyboard.press("Escape");
        await expect(dialog).not.toBeVisible();
      }
    });

    await appTest.step("QADD-03 plain priority words stay in the title, not eaten", async () => {
      const dialog = await typeQuickAdd(app, "tidy desk low priority");
      await expect(dialog.getByRole("button", { name: "Priority: Priority" })).toBeVisible();
      await app.keyboard.press("Enter");
      await openRow(app, "tidy desk low priority");
    });
  }
);

appTest(
  "a reminder and a note typed inline land on the page",
  { tag: ["@QADD-04"] },
  async ({ app }) => {
    const dialog = await typeQuickAdd(
      app,
      "Dentist tomorrow 3pm remind 30m before // ask about the crown"
    );

    await appTest.step("QADD-04 the reminder chip echoes the lead", async () => {
      await expect(dialog.getByText("30 min before")).toBeVisible();
      await app.keyboard.press("Enter");
      await expect(dialog).not.toBeVisible();
    });

    await appTest.step("QADD-04 the page has the note as its body and the reminder", async () => {
      await openRow(app, "Dentist");
      await expect(app.getByRole("textbox", { name: "Page content" })).toHaveText(
        "ask about the crown"
      );
      const menu = await openReminders(app);
      await expect(
        menu.getByRole("menuitemcheckbox", { name: "30 min before" })
      ).toHaveAttribute("aria-checked", "true");
    });
  }
);

appTest(
  "a day-before reminder collapses on a dated page and stays text on an undated one",
  { tag: ["@QADD-05"] },
  async ({ app }) => {
    await appTest.step("QADD-05 !r1d on a date-only page is the day-before lead", async () => {
      const dialog = await typeQuickAdd(app, "pay rent tomorrow !r1d");
      await expect(dialog.getByText("Day before")).toBeVisible();
      await app.keyboard.press("Enter");
      await openRow(app, "pay rent");
      const menu = await openReminders(app);
      await expect(
        menu.getByRole("menuitemcheckbox", { name: "Day before at 9:00" })
      ).toHaveAttribute("aria-checked", "true");
      await app.keyboard.press("Escape");
    });

    await appTest.step("QADD-05 the words form does the same", async () => {
      const dialog = await typeQuickAdd(app, "book tickets tomorrow remind me the day before");
      await expect(dialog.getByText("Day before")).toBeVisible();
      await app.keyboard.press("Escape");
    });

    await appTest.step("QADD-05 on an unscheduled page the words stay in the title", async () => {
      const dialog = await typeQuickAdd(app, "call mum remind me the day before");
      await expect(dialog.getByRole("button", { name: "Set schedule" })).toBeVisible();
      await expect(dialog.getByText("Day before")).toHaveCount(0);
      await app.keyboard.press("Enter");
      await openRow(app, "call mum remind me the day before");
    });
  }
);

appTest(
  "Enter, Cmd+Enter, Shift+Enter and Cmd+T each do their one thing",
  { tag: ["@QADD-06"] },
  async ({ app }) => {
    const { dialog, input } = quickAddParts(app);

    await appTest.step("QADD-06 Enter adds and closes", async () => {
      await typeQuickAdd(app, "first thing");
      await app.keyboard.press("Enter");
      await expect(dialog).not.toBeVisible();
      await expect(row(app, "first thing")).toBeVisible();
    });

    await appTest.step("QADD-06 Cmd+Enter adds and stays open for the next", async () => {
      await typeQuickAdd(app, "second thing");
      await app.keyboard.press(mod("Mod+Enter"));
      await expect(dialog).toBeVisible();
      await expect(row(app, "second thing")).toBeVisible();
      await expect(input).toHaveValue("", { timeout: 2000 });
      await app.keyboard.press("Escape");
    });

    await appTest.step("QADD-06 Shift+Enter adds and opens the page", async () => {
      await typeQuickAdd(app, "third thing");
      await app.keyboard.press("Shift+Enter");
      await expect(dialog).not.toBeVisible();
      await expect(app.getByLabel("Page title")).toHaveText("third thing");
    });

    await appTest.step("QADD-06 Cmd+T schedules for today", async () => {
      await typeQuickAdd(app, "fourth thing");
      await expect(dialog.getByRole("button", { name: "Set schedule" })).toBeVisible();
      await app.keyboard.press(mod("Mod+t"));
      await expect(dialog.getByRole("button", { name: /^Scheduled: Today/ })).toBeVisible();
      await app.keyboard.press("Enter");
      await openRow(app, "fourth thing");
      await expect(app.getByRole("button", { name: /^Scheduled: Today/ })).toBeVisible();
    });
  }
);

appTest(
  "cadences make one recurring page, and a day list makes one page per day",
  { tag: ["@QADD-08"] },
  async ({ app }) => {
    for (const [text, title, cadence] of [
      ["trash out every other tuesday", "trash out", /recurrence: every 2 weeks on Tuesday/i],
      ["physio for 3 weeks", "physio", /recurrence: every day until/i],
      ["stretch 10 times", "stretch", /recurrence: every day for 10 times/i],
    ] as const) {
      await appTest.step(`QADD-08 "${text}" is one recurring page`, async () => {
        const dialog = await typeQuickAdd(app, text);
        await expect(dialog.getByRole("button", { name: cadence })).toBeVisible();
        await app.keyboard.press("Enter");
        await expect(row(app, title)).toHaveCount(1);
        await openRow(app, title);
        await expect(app.getByRole("button", { name: cadence })).toBeVisible();
      });
    }

    await appTest.step('QADD-08 "m/w/f" is three separate pages', async () => {
      const dialog = await typeQuickAdd(app, "gym m/w/f");
      await expect(dialog.getByRole("button", { name: /Recurrence: 3 occurrences/i })).toBeVisible();
      await app.keyboard.press("Enter");
      await expect(row(app, "gym")).toHaveCount(3);
    });
  }
);

appTest(
  "a duration and a time range make timed blocks, and a weekday range makes a span",
  { tag: ["@QADD-07"] },
  async ({ app }) => {
    const calendar = app.getByRole("region", { name: "Week calendar" });

    async function addAndView(text: string, title: string) {
      await typeQuickAdd(app, text);
      await app.keyboard.press("Enter");
      await app.getByRole("button", { name: "Editor view" }).click();
      await openRow(app, title);
      await app.getByRole("button", { name: "View in calendar" }).click();
      await expect(calendar).toBeVisible();
    }

    await appTest.step('QADD-07 "9am for 30 min" is a 9 to 9:30 block', async () => {
      await addAndView("standup 9am for 30 min", "standup");
      await expect(calendar.getByRole("button", { name: "standup, 9–9:30 AM" })).toBeVisible();
    });

    await appTest.step('QADD-07 "3pm to 5pm" is a 3 to 5 block', async () => {
      await addAndView("workshop 3pm to 5pm", "workshop");
      await expect(calendar.getByRole("button", { name: "workshop, 3–5 PM" })).toBeVisible();
    });

    await appTest.step('QADD-07 "from Mon to Fri" is one bar across five days', async () => {
      await addAndView("offsite from Mon to Fri", "offsite");
      const bar = calendar.getByRole("button", { exact: true, name: "offsite" });
      await expect(bar).toHaveCount(1);
      const barBox = await bar.boundingBox();
      const cellBox = await calendar.getByLabel(/^All-day events, Monday /).boundingBox();
      if (!barBox || !cellBox) throw new Error("no bar or Monday cell");
      expect(Math.round(barBox.width / cellBox.width)).toBe(5);
      expect(Math.abs(barBox.x - cellBox.x)).toBeLessThan(cellBox.width / 2);
    });
  }
);
