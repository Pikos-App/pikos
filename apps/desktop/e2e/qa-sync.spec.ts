import type { Locator, Page } from "@playwright/test";

import {
  test as appTest,
  bridgeCall,
  expect,
  mod,
  openCalendarMode,
  quickAdd,
  seedSynced,
  WRITE_QUEUE_DEBOUNCE_MS,
} from "./fixtures";

appTest.use({ timezoneId: "America/New_York" });

const LOCK_HINT = "Title, date, and schedule are read-only for synced pages";

function rows(app: Page, title: string) {
  return app.locator("[data-page-list-item]").filter({ hasText: title });
}

function dateLabel(row: Locator) {
  return row.getByRole("button", { name: /^Toggle date format:/ });
}

/** A calendar folder in the sidebar. The realistic seed has ordinary folders of the same names,
 *  and those are the sortable ones. */
function calendarFolder(app: Page, name: string) {
  return app
    .getByRole("group", { name: "Views and folders" })
    .locator(`[aria-label="${name}"]:not([aria-roledescription="sortable"])`);
}

async function openCalendarFolder(app: Page, name: string) {
  const folder = calendarFolder(app, name);
  await expect(async () => {
    await folder.click();
    await expect(folder).toHaveAttribute("aria-current", "true", { timeout: 500 });
  }).toPass();
}

/** A date `offset` days from today, as the app prints it in the shape asked for. */
async function dayLabel(app: Page, offset: number, shape: "list" | "gap"): Promise<string> {
  return app.evaluate(
    ([days, kind]) => {
      const d = new Date();
      d.setDate(d.getDate() + days);
      const month = d.toLocaleDateString("en-US", { month: "short" });
      const day = d.getDate();
      if (kind === "list") return `${month} ${day}`;
      return `${d.toLocaleDateString("en-US", { weekday: "short" })} ${month} ${day}`;
    },
    [offset, shape] as const
  );
}

/** A wall-clock `offset` days from today, as a provider sends one. */
async function stamp(app: Page, offset: number, time: string): Promise<string> {
  return app.evaluate(
    ([days, hm]) => {
      const d = new Date();
      d.setDate(d.getDate() + days);
      const pad = (n: number) => String(n).padStart(2, "0");
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${hm}:00`;
    },
    [offset, time] as const
  );
}

/** Change what the calendar server holds and run the poll that would notice. The reload
 *  stands in for the refresh the app gets when a sync pass lands. */
async function upstream(app: Page, command: string, args: Record<string, unknown>) {
  await bridgeCall(app, command, args);
  await app.reload();
  await expect(app.getByRole("main", { name: "Workspace" })).toBeVisible();
}

async function openSyncPanel(app: Page) {
  await app.getByRole("button", { name: "Open settings" }).click();
  await app.getByRole("button", { exact: true, name: "Calendar sync" }).click();
}

async function dragBy(app: Page, from: { x: number; y: number }, dx: number, dy: number) {
  await app.mouse.move(from.x, from.y);
  await app.mouse.down();
  await app.mouse.move(from.x + Math.sign(dx) * 16, from.y + Math.sign(dy) * 16, { steps: 4 });
  await app.mouse.move(from.x + dx, from.y + dy, { steps: 10 });
  await app.mouse.up();
}

async function openFromSearch(app: Page, title: string) {
  await app.keyboard.press(mod("Mod+k"));
  const palette = app.getByRole("dialog", { name: "Search pages" });
  await palette.getByPlaceholder("Search pages, or > for commands…").fill(title);
  await palette
    .getByRole("button", { name: new RegExp(`^${title}`) })
    .first()
    .click();
  await expect(palette).not.toBeVisible();
}

appTest(
  "a mirror locks title, schedule, repeat and folder, and leaves the rest editable",
  { tag: ["@SYNC-12:2"] },
  async ({ app }) => {
    await seedSynced(app);
    await openCalendarFolder(app, "Personal");
    const standup = rows(app, "Team standup");
    await standup.click();

    await appTest.step("SYNC-12 the title is text with a lock icon and its tooltip", async () => {
      await expect(app.getByRole("button", { name: "Page title" })).toHaveCount(0);
      const lock = app.getByRole("img", { name: LOCK_HINT });
      await expect(lock).toBeVisible();
      await lock.hover();
      await expect(app.getByRole("tooltip")).toHaveText(LOCK_HINT);
    });

    await appTest.step("SYNC-12 date, time, repeat and folder offer no control", async () => {
      await expect(app.getByText("Today 11:00am · 30m")).toBeVisible();
      for (const name of [/^Scheduled: /, /^Folder: /, "Set recurrence", /^Repeats/]) {
        await expect(app.getByRole("button", { name })).toHaveCount(0);
      }
    });

    await appTest.step(
      "SYNC-12 the context menu has no Move to folder, No date or Rename",
      async () => {
        await standup.click({ button: "right" });
        await expect(app.getByRole("menuitem", { name: "Delete" })).toBeVisible();
        for (const name of ["Move to folder", "No date", "Rename"]) {
          await expect(app.getByRole("menuitem", { name })).toHaveCount(0);
        }
        await app.keyboard.press("Escape");
      }
    );

    await appTest.step(
      "SYNC-12 body, tags, priority, status and reminders take edits",
      async () => {
        await app.getByRole("textbox", { name: "Page content" }).click();
        await app.keyboard.press("End");
        await app.keyboard.type(" Bring the numbers.");
        await expect(app.getByRole("textbox", { name: "Page content" })).toContainText(
          "Bring the numbers."
        );

        await app.getByRole("button", { name: "Tags: none" }).click();
        await app.getByPlaceholder("Search or create…").fill("meetings");
        await app.keyboard.press("Enter");
        await app.keyboard.press("Escape");
        await expect(app.getByRole("button", { name: "Tags: meetings" })).toBeVisible();

        await app.getByRole("button", { name: /^Priority: / }).click();
        await app.getByRole("menuitem", { name: /High/ }).click();
        await expect(app.getByRole("button", { name: "Priority: High" })).toBeVisible();

        await app.getByRole("button", { name: "Page reminders" }).click();
        const lead = app.getByRole("menu").getByRole("menuitemcheckbox", { name: "30 min before" });
        await lead.click();
        await expect(lead).toBeChecked();
        await app.keyboard.press("Escape");

        await standup.getByRole("checkbox", { name: "Mark done" }).click();
        await expect(standup).toHaveCount(0);
        await expect(app.getByText(/read-only/i)).toHaveCount(0);
      }
    );

    await appTest.step("SYNC-12 a block refuses a drag and a resize", async () => {
      await openCalendarMode(app);
      const block = app.getByRole("button", { name: /Design review \(LA team\),/ });
      await expect(block).toBeVisible();
      const label = await block.getAttribute("aria-label");
      const box = (await block.boundingBox())!;
      await dragBy(app, { x: box.x + box.width / 2, y: box.y + box.height / 2 }, 0, 160);
      await expect(block).toHaveAttribute("aria-label", label!);
      const moved = (await block.boundingBox())!;
      await dragBy(app, { x: moved.x + moved.width / 2, y: moved.y + moved.height - 2 }, 0, 120);
      await expect(block).toHaveAttribute("aria-label", label!);
      expect(Math.abs((await block.boundingBox())!.height - box.height)).toBeLessThan(3);
    });

    await appTest.step("SYNC-12 a list-to-calendar drag of a mirror doesn't take", async () => {
      await openCalendarFolder(app, "Personal");
      const row = rows(app, "Design review (LA team)");
      const before = await dateLabel(row).getAttribute("aria-label");
      const grid = (await app.getByRole("region", { name: "Week calendar" }).boundingBox())!;
      const start = (await row.boundingBox())!;
      const from = { x: start.x + start.width / 2, y: start.y + start.height / 2 };
      await app.mouse.move(from.x, from.y);
      await app.mouse.down();
      await app.mouse.move(from.x + 16, from.y, { steps: 4 });
      await app.mouse.move(grid.x + grid.width * 0.6, grid.y + grid.height * 0.4, { steps: 10 });
      await expect(app.locator("[data-drag-ghost]")).toHaveCount(0);
      await app.mouse.up();
      await expect(dateLabel(row)).toHaveAttribute("aria-label", before!);
    });
  }
);

appTest(
  "a mixed selection dropped on Today moves the ordinary page and leaves the mirror",
  { tag: ["@SYNC-12:2"] },
  async ({ app }) => {
    await seedSynced(app);
    await quickAdd(app, "desk tidy today at 11:59pm");
    await app.getByRole("button", { name: /^Today/ }).click();
    const mirror = rows(app, "Company offsite");
    const ordinary = rows(app, "desk tidy");
    const mirrorBefore = await dateLabel(mirror).getAttribute("aria-label");
    await expect(dateLabel(ordinary)).toHaveAttribute("aria-label", /11:59pm/);

    await mirror.click();
    await ordinary.click({ modifiers: ["ControlOrMeta"] });
    await expect(mirror).toHaveAttribute("data-selected", "true");
    await expect(ordinary).toHaveAttribute("data-selected", "true");

    await appTest.step("SYNC-12 only the ordinary page takes the drop", async () => {
      const todayRow = app.getByRole("button", { name: /^Today/ });
      const target = (await todayRow.boundingBox())!;
      const start = (await ordinary.boundingBox())!;
      const from = { x: start.x + start.width / 2, y: start.y + start.height / 2 };
      await app.mouse.move(from.x, from.y);
      await app.mouse.down();
      await app.mouse.move(from.x - 16, from.y - 16, { steps: 4 });
      await app.mouse.move(target.x + target.width / 2, target.y + target.height / 2, {
        steps: 10,
      });
      // Released in the frame the pointer arrives, the drop still belongs to the row it left.
      await expect(todayRow).toHaveAttribute("data-drag-over", "true");
      await app.mouse.up();
      await expect(dateLabel(ordinary)).not.toHaveAttribute("aria-label", /11:59pm/);
      await expect(dateLabel(mirror)).toHaveAttribute("aria-label", mirrorBefore!);
      await expect(app.getByText(/read-only/i)).toHaveCount(0);
    });
  }
);

appTest(
  "a mirror shows its room and guests, and search finds it by either, quoting the match",
  { tag: ["@SYNC-13"] },
  async ({ app }) => {
    await seedSynced(app);
    await openCalendarFolder(app, "Personal");
    await rows(app, "Team standup").click();

    await appTest.step("SYNC-13 the room and the guests show on the page", async () => {
      await expect(app.getByText("Zoom")).toBeVisible();
      await expect(app.getByText("3 guests")).toBeVisible();
    });

    for (const term of ["Zoom", "sam@example.com"]) {
      await appTest.step(`SYNC-13 searching ${term} finds it and highlights the term`, async () => {
        await app.keyboard.press(mod("Mod+k"));
        const palette = app.getByRole("dialog", { name: "Search pages" });
        await palette.getByPlaceholder("Search pages, or > for commands…").fill(term);
        const hit = palette.getByRole("button", { name: /^Team standup/ });
        await expect(hit).toBeVisible();
        await expect(hit.locator("mark")).toHaveText([term]);
        await app.keyboard.press("Escape");
      });
    }
  }
);

appTest(
  "mirrors live in their calendar folder, sorted by date, and never in Inbox",
  { tag: ["@SYNC-17"] },
  async ({ app }) => {
    await seedSynced(app);
    const mirrors = [
      "Team standup",
      "Design review (LA team)",
      "Company offsite",
      "Weekly 1:1 (London)",
    ];

    await appTest.step("SYNC-17 none of them is in Inbox", async () => {
      await app.getByRole("button", { name: /^Inbox/ }).click();
      await expect(app.locator("[data-page-list-item]").first()).toBeVisible();
      for (const title of mirrors) await expect(rows(app, title)).toHaveCount(0);
    });

    await appTest.step("SYNC-17 they are in their calendar folder, in date order", async () => {
      await openCalendarFolder(app, "Personal");
      for (const title of mirrors) await expect(rows(app, title).first()).toBeVisible();
      await expect(app.getByRole("button", { name: "Sort: date" })).toBeVisible();
    });
  }
);

appTest(
  "a calendar folder's colour matches in the sidebar and the Sync panel, survives re-discovery, and can't be renamed, moved or deleted",
  { tag: ["@SYNC-18"] },
  async ({ app, storage }) => {
    appTest.skip(storage !== "bridge", "re-discovery needs the bridge's scripted calendar server");
    await seedSynced(app);
    const sidebarColor = calendarFolder(app, "Personal").getByTestId("calendar-color");
    // Retried: an element detached between resolving and reading computes no colour.
    const readSidebarColor = async () => {
      let color = "";
      await expect
        .poll(async () => {
          color = await sidebarColor.evaluate((el) => getComputedStyle(el).color);
          return color;
        })
        .toMatch(/^rgb/);
      return color;
    };
    const panelSwatch = () => app.getByRole("button", { name: "Colour for Personal" });
    const same = async () => {
      const icon = await readSidebarColor();
      await openSyncPanel(app);
      await expect(panelSwatch()).toHaveCSS("background-color", icon);
      await app.keyboard.press("Escape");
    };

    await appTest.step("SYNC-18 recolouring from the sidebar shows in the Sync panel", async () => {
      await calendarFolder(app, "Personal").click({ button: "right" });
      await app.getByRole("menuitem", { name: "Color" }).click();
      await app.getByRole("menuitem", { name: "Lavender" }).click();
      await same();
    });

    await appTest.step("SYNC-18 recolouring from the Sync panel shows in the sidebar", async () => {
      const before = await readSidebarColor();
      await openSyncPanel(app);
      await panelSwatch().click();
      await app.getByRole("button", { name: "Sage" }).click({ force: true });
      await app.keyboard.press("Escape");
      await expect(sidebarColor).not.toHaveCSS("color", before);
      await same();
    });

    await appTest.step(
      "SYNC-18 the colour survives the calendar being discovered again",
      async () => {
        const chosen = await readSidebarColor();
        await upstream(app, "upstream_discover", {
          calendars: [
            { calendarId: "mock-personal", color: "#d50000", displayName: "Personal" },
            { calendarId: "mock-work", color: "#0b8043", displayName: "Work" },
          ],
        });
        await expect(sidebarColor).toHaveCSS("color", chosen);
        await same();
      }
    );

    await appTest.step(
      "SYNC-18 its menu offers only Color, and it is neither renamable nor draggable",
      async () => {
        await calendarFolder(app, "Personal").click({ button: "right" });
        await expect(app.getByRole("menu").getByRole("menuitem")).toHaveText(["Color"]);
        await app.keyboard.press("Escape");
        await calendarFolder(app, "Personal").dblclick();
        await expect(
          app.getByRole("group", { name: "Views and folders" }).getByRole("textbox")
        ).toHaveCount(0);
      }
    );
  }
);

appTest(
  "ticking a synced series advances its head, untick restores it, and a moved instance completes its original",
  { tag: ["@SYNC-19"] },
  async ({ app }) => {
    await seedSynced(app);
    await openCalendarFolder(app, "Personal");
    const series = rows(app, "Weekly 1:1 (London)");
    const open = series.filter({ has: app.getByRole("checkbox", { name: "Mark done" }) });
    const done = series.filter({ has: app.getByRole("checkbox", { name: "Mark not done" }) });
    const today = await dateLabel(open).getAttribute("aria-label");

    await appTest.step(
      "SYNC-19 the tick leaves one done clone and the head a week on",
      async () => {
        await open.getByRole("checkbox", { name: "Mark done" }).click();
        await expect(dateLabel(open)).toHaveAttribute(
          "aria-label",
          `Toggle date format: ${await dayLabel(app, 7, "list")}`
        );
        await expect(app.getByText(/read-only/i)).toHaveCount(0);
        await app.getByRole("button", { exact: true, name: "Completed" }).click();
        await expect(done).toHaveCount(1);
      }
    );

    await appTest.step("SYNC-19 unticking the clone puts the head back", async () => {
      await done.getByRole("checkbox", { name: "Mark not done" }).click();
      await expect(done).toHaveCount(0);
      await expect(dateLabel(open)).toHaveAttribute("aria-label", today!);
    });

    await appTest.step(
      "SYNC-19 a moved instance sits at its new slot, locked, and completes",
      async () => {
        await openCalendarMode(app);
        const moved = app.getByRole("button", { name: /Recurring review, 3/ });
        for (let i = 0; i < 6 && (await moved.count()) === 0; i++) {
          await app.getByRole("button", { name: "Next week" }).click();
          await app.waitForTimeout(400);
        }
        await moved.click();
        const popover = app.getByRole("dialog");
        await expect(popover.getByRole("img", { name: LOCK_HINT })).toBeVisible();
        await expect(popover.getByRole("textbox")).toHaveCount(0);
        await popover.getByRole("button", { name: "Mark done" }).click();
        await expect(app.getByText(/read-only/i)).toHaveCount(0);
        await app.keyboard.press("Escape");
        await moved.click();
        await expect(
          app.getByRole("dialog").getByRole("button", { name: "Mark not done" })
        ).toBeVisible();
      }
    );
  }
);

appTest(
  "a synced virtual resolves alone, and a moved instance is removed from Pikos alone",
  { tag: ["@SYNC-20"] },
  async ({ app }) => {
    await seedSynced(app);
    await openCalendarMode(app);
    const nextWeek = () => app.getByRole("button", { name: "Next week" }).click();

    await appTest.step("SYNC-20 ticking a virtual resolves that instance only", async () => {
      for (let i = 0; i < 3; i++) await nextWeek();
      const virtual = app.getByRole("button", { name: /Weekly 1:1 \(London\)/ }).first();
      await virtual.click();
      await app.getByRole("dialog").getByRole("button", { name: "Mark done" }).click();
      await expect(app.getByText(/read-only/i)).toHaveCount(0);
      await app.keyboard.press("Escape");
      await virtual.click();
      await expect(
        app.getByRole("dialog").getByRole("button", { name: "Mark not done" })
      ).toBeVisible();
      await app.keyboard.press("Escape");
      await nextWeek();
      await app
        .getByRole("button", { name: /Weekly 1:1 \(London\)/ })
        .first()
        .click();
      await expect(
        app.getByRole("dialog").getByRole("button", { name: "Mark done" })
      ).toBeVisible();
      await app.keyboard.press("Escape");
    });

    await appTest.step(
      "SYNC-20 a moved instance's delete names the local copy and takes only it",
      async () => {
        await app.getByRole("button", { name: "Jump to current week" }).click();
        const moved = app.getByRole("button", { name: /Recurring review, 3/ });
        for (let i = 0; i < 6 && (await moved.count()) === 0; i++) {
          await nextWeek();
          await app.waitForTimeout(400);
        }
        await moved.click();
        await app.getByRole("button", { name: "Remove this occurrence from Pikos" }).click();
        await expect(moved).toHaveCount(0);
        await nextWeek();
        await expect(app.getByRole("button", { name: /Recurring review, 10/ })).toBeVisible();
        await openCalendarFolder(app, "Personal");
        await expect(rows(app, "Recurring review")).toHaveCount(1);
      }
    );
  }
);

appTest(
  "a detached page gets every control back, and says whether the detach can be undone",
  { tag: ["@SYNC-24"] },
  async ({ app }) => {
    await seedSynced(app);
    const controls = async () => {
      await expect(app.getByRole("button", { name: "Page title" })).toBeVisible();
      await expect(app.getByRole("button", { name: /^Folder: / })).toBeVisible();
      await expect(app.getByRole("button", { name: /^Scheduled: / })).toBeVisible();
      await expect(app.getByRole("button", { name: "Set recurrence" })).toBeVisible();
      await expect(app.getByRole("img", { name: LOCK_HINT })).toHaveCount(0);
    };

    await appTest.step("SYNC-24 an event removed upstream reads as permanent", async () => {
      await openCalendarFolder(app, "Work");
      await rows(app, "Old planning (detached)").click();
      await expect(
        app.getByText("Removed from the Work calendar. This is a regular page now.")
      ).toBeVisible();
      await controls();
    });

    await appTest.step("SYNC-24 a calendar turned off reads as reversible", async () => {
      await openSyncPanel(app);
      await app.getByRole("switch", { name: "Sync Personal" }).click();
      await app
        .getByRole("alertdialog", { name: "Turn Personal off?" })
        .getByRole("button", { name: "Turn off" })
        .click();
      await expect(app.getByRole("switch", { name: "Sync Personal" })).not.toBeChecked();
      await app.keyboard.press("Escape");
      await openFromSearch(app, "Team standup");
      await expect(
        app.getByText("The Personal calendar is turned off. Turn it back on and this page rejoins.")
      ).toBeVisible();
      await controls();
    });
  }
);

appTest(
  "a synced series' backlog opens the gap dialog, starting at the connect day",
  { tag: ["@SYNC-26"] },
  async ({ app }) => {
    await seedSynced(app);
    await openCalendarFolder(app, "Work");
    const series = rows(app, "Release countdown");
    const head = series.filter({ has: app.getByRole("checkbox", { name: "Mark done" }) });

    await appTest.step("SYNC-26 the head sits on the connect day, nothing earlier", async () => {
      await expect(dateLabel(head)).toHaveAttribute(
        "aria-label",
        `Toggle date format: ${await dayLabel(app, -5, "list")}`
      );
    });

    await appTest.step(
      "SYNC-26 the tick asks, listing only days since the connect day",
      async () => {
        await head.getByRole("checkbox", { name: "Mark done" }).click();
        const dialog = app.getByRole("dialog", { name: "Mark “Release countdown” done?" });
        await expect(dialog).toContainText(
          `4 other days are still open: ${await dayLabel(app, -4, "gap")}, ${await dayLabel(app, -3, "gap")}, and 2 more.`
        );
        await dialog.getByRole("button", { name: /This and everything before today/ }).click();
        await expect(dialog).not.toBeVisible();
        await expect(app.getByText(/read-only/i)).toHaveCount(0);
        await expect(dateLabel(head)).toHaveAttribute(
          "aria-label",
          /Toggle date format: \d{1,2}:\d{2}[ap]m/
        );
      }
    );
  }
);

appTest(
  "an upstream description refreshes an untouched body silently, and waits beside an edited one",
  { tag: ["@SYNC-16"] },
  async ({ app, storage }) => {
    appTest.skip(storage !== "bridge", "needs the bridge's scripted calendar server");
    await seedSynced(app);
    const body = app.getByRole("textbox", { name: "Page content" });
    const notice = app.getByText("The calendar description changed.");
    const open = async (title: string) => {
      await openCalendarFolder(app, "Personal");
      await rows(app, title).click();
      await expect(body).toBeVisible();
    };

    await appTest.step(
      "SYNC-16 an untouched body takes the new description with no notice",
      async () => {
        await upstream(app, "upstream_sync", {
          calendar: "Personal",
          events: [
            { description: "Walk through the new sync panel.", title: "Design review (LA team)" },
          ],
        });
        await open("Design review (LA team)");
        await expect(body).toContainText("Walk through the new sync panel.");
        await expect(notice).toHaveCount(0);
      }
    );

    await appTest.step("SYNC-16 an edited body keeps its words and shows the notice", async () => {
      await upstream(app, "upstream_sync", {
        calendar: "Personal",
        events: [{ description: "Agenda two: blockers first.", title: "Team standup" }],
      });
      await open("Team standup");
      await expect(notice).toBeVisible();
      await expect(body).toHaveText("My prep: land the calendar-sync PR before we demo.");
      await app.getByRole("button", { exact: true, name: "View" }).click();
      await expect(app.getByText("Agenda two: blockers first.")).toBeVisible();
    });

    await appTest.step("SYNC-16 Append puts it under the body and clears the notice", async () => {
      await app.getByRole("button", { name: "Append" }).click();
      await expect(notice).toHaveCount(0);
      await expect(body).toContainText("My prep: land the calendar-sync PR before we demo.");
      await expect(body).toContainText("Agenda two: blockers first.");
    });

    await appTest.step(
      "SYNC-16 a later change is parked again, and Dismiss leaves the body alone",
      async () => {
        await app.waitForTimeout(2 * WRITE_QUEUE_DEBOUNCE_MS);
        await upstream(app, "upstream_sync", {
          calendar: "Personal",
          events: [{ description: "Agenda three: cancelled.", title: "Team standup" }],
        });
        await open("Team standup");
        await expect(notice).toBeVisible();
        await app.getByRole("button", { name: "Dismiss" }).click();
        await expect(notice).toHaveCount(0);
        await expect(body).not.toContainText("Agenda three");
        await expect(body).toContainText("Agenda two: blockers first.");
        await app.reload();
        await open("Team standup");
        await expect(notice).toHaveCount(0);
      }
    );
  }
);

appTest(
  "enabling a calendar adds its folder and backfills; disabling asks, drops bare mirrors, keeps owned pages",
  { tag: ["@SYNC-06", "@SYNC-23:2"] },
  async ({ app, storage }) => {
    appTest.skip(storage !== "bridge", "needs the bridge's scripted calendar server");
    await seedSynced(app);
    await upstream(app, "upstream_discover", {
      calendars: [
        { calendarId: "mock-personal", displayName: "Personal" },
        { calendarId: "mock-work", displayName: "Work" },
        { calendarId: "mock-family", displayName: "Family" },
        { calendarId: "mock-holidays", displayName: "Holidays" },
      ],
    });
    const family = calendarFolder(app, "Family");
    const holidays = calendarFolder(app, "Holidays");
    const turnOff = async (name: string) => {
      await openSyncPanel(app);
      await app.getByRole("switch", { name: `Sync ${name}` }).click();
      const confirm = app.getByRole("alertdialog", { name: `Turn ${name} off?` });
      await expect(confirm).toBeVisible();
      await confirm.getByRole("button", { name: "Turn off" }).click();
      await expect(app.getByRole("switch", { name: `Sync ${name}` })).not.toBeChecked();
      await app.keyboard.press("Escape");
    };

    await appTest.step(
      "SYNC-06 turning a calendar on adds its folder, and the first poll fills it",
      async () => {
        await openSyncPanel(app);
        for (const name of ["Family", "Holidays"]) {
          const toggle = app.getByRole("switch", { name: `Sync ${name}` });
          await expect(toggle).not.toBeChecked();
          await toggle.click();
          await expect(toggle).toBeChecked();
          await expect(app.getByRole("alertdialog")).toHaveCount(0);
        }
        await app.keyboard.press("Escape");
        await expect(family).toBeVisible();
        await expect(holidays).toBeVisible();

        const at = (days: number, hm: string) => stamp(app, days, hm);
        await bridgeCall(app, "upstream_sync", {
          calendar: "Holidays",
          events: [
            {
              end: await at(3, "12:00"),
              start: await at(3, "11:00"),
              timezone: "America/New_York",
              title: "Harvest fair",
            },
          ],
        });
        await upstream(app, "upstream_sync", {
          calendar: "Family",
          events: [
            {
              end: await at(1, "11:00"),
              start: await at(1, "10:00"),
              timezone: "America/New_York",
              title: "Swim meet",
            },
            {
              end: await at(2, "19:00"),
              start: await at(2, "18:00"),
              timezone: "America/New_York",
              title: "School play",
            },
          ],
        });
        await openCalendarFolder(app, "Family");
        await expect(rows(app, "Swim meet")).toBeVisible();
        await expect(rows(app, "School play")).toBeVisible();
      }
    );

    await appTest.step(
      "SYNC-06 turning it off asks, drops the bare mirror, and keeps the one worked in",
      async () => {
        await rows(app, "School play").click();
        await app.getByRole("textbox", { name: "Page content" }).click();
        await app.keyboard.type("Bring flowers.");
        await rows(app, "Swim meet").click();
        await app.waitForTimeout(2 * WRITE_QUEUE_DEBOUNCE_MS);
        await turnOff("Family");

        await expect(app.getByRole("button", { exact: true, name: "Family" })).toBeVisible();
        await openFromSearch(app, "School play");
        await expect(
          app.getByText("The Family calendar is turned off. Turn it back on and this page rejoins.")
        ).toBeVisible();
        await app.keyboard.press(mod("Mod+k"));
        const palette = app.getByRole("dialog", { name: "Search pages" });
        await palette.getByPlaceholder("Search pages, or > for commands…").fill("Swim meet");
        await expect(palette.getByText("No pages found")).toBeVisible();
        await app.keyboard.press("Escape");
      }
    );

    await appTest.step(
      "SYNC-06 a calendar with nothing kept takes its folder with it",
      async () => {
        await turnOff("Holidays");
        await expect(app.getByRole("button", { exact: true, name: "Holidays" })).toHaveCount(0);
      }
    );

    await appTest.step(
      "SYNC-23 a calendar that kept nothing turns back on with no dialog",
      async () => {
        await openSyncPanel(app);
        const toggle = app.getByRole("switch", { name: "Sync Holidays" });
        await toggle.click();
        await expect(toggle).toBeChecked();
        await expect(app.getByRole("alertdialog")).toHaveCount(0);
        await app.keyboard.press("Escape");
      }
    );
  }
);

/** Page forward until a block of this name shows, from the current week. */
async function findBlock(app: Page, name: RegExp) {
  const block = app.getByRole("button", { name });
  const week = app.getByRole("region", { name: "Week calendar" });
  for (let i = 0; i < 6; i++) {
    // A week counted before its pages land reads as empty and pages past the block.
    await expect(week).toHaveAttribute("aria-busy", "false");
    if ((await block.count()) > 0) break;
    await app.getByRole("button", { name: "Next week" }).click();
  }
  await expect(block).toHaveCount(1);
  return block;
}

appTest(
  "a detached series' moved occurrence is editable and completes on its original date",
  { tag: ["@SYNC-25:2"] },
  async ({ app }) => {
    await seedSynced(app);
    await openCalendarMode(app);
    const moved = await findBlock(app, /Detached sprint, 3/);

    await appTest.step("SYNC-25 it renders once and opens editable", async () => {
      await moved.click();
      const title = app.getByPlaceholder("Untitled");
      await expect(title).toHaveValue("Detached sprint");
      await expect(app.getByRole("dialog").getByRole("img", { name: LOCK_HINT })).toHaveCount(0);
    });

    await appTest.step(
      "SYNC-25 completing it records that occurrence, not the series",
      async () => {
        await app.getByRole("button", { name: "Mark done" }).click();
        await app.keyboard.press("Escape");
        await moved.click();
        await expect(app.getByRole("button", { name: "Mark not done" })).toBeVisible();
        await app.keyboard.press("Escape");
        await openCalendarFolder(app, "Work");
        await expect(
          rows(app, "Detached sprint").filter({
            has: app.getByRole("checkbox", { name: "Mark done" }),
          })
        ).toHaveCount(1);
      }
    );
  }
);

appTest(
  "re-linking a detached series puts a moved occurrence back at the provider's time, one block throughout",
  { tag: ["@SYNC-25:2"] },
  async ({ app, storage }) => {
    appTest.skip(storage !== "bridge", "needs the bridge's scripted calendar server");
    await seedSynced(app);
    await openCalendarMode(app);
    const at3 = /Detached sprint, 3/;
    const at4 = /Detached sprint, 4/;

    await appTest.step("SYNC-25 moving it while detached leaves one block", async () => {
      const moved = await findBlock(app, at3);
      const box = (await moved.boundingBox())!;
      await dragBy(app, { x: box.x + box.width / 2, y: box.y + box.height / 2 }, 0, 60);
      await expect(app.getByRole("button", { name: at4 })).toHaveCount(1);
      await expect(app.getByRole("button", { name: at3 })).toHaveCount(0);
    });

    await appTest.step(
      "SYNC-25 the next poll re-links it at the provider's time, locked",
      async () => {
        const t = (days: number, hm: string) => stamp(app, days, hm);
        await upstream(app, "upstream_sync", {
          calendar: "Work",
          events: [
            {
              end: await t(0, "07:45"),
              overrides: [
                {
                  end: await t(16, "15:30"),
                  original: await t(14, "07:15"),
                  start: await t(16, "15:00"),
                },
              ],
              rrule: "FREQ=WEEKLY",
              start: await t(0, "07:15"),
              timezone: "America/New_York",
              title: "Detached sprint",
            },
          ],
        });
        await openCalendarMode(app);
        const back = await findBlock(app, at3);
        await expect(app.getByRole("button", { name: at4 })).toHaveCount(0);
        await back.click();
        await expect(app.getByRole("dialog").getByRole("img", { name: LOCK_HINT })).toBeVisible();
      }
    );
  }
);
