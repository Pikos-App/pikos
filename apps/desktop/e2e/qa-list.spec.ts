import { execFileSync } from "node:child_process";

import type { Page } from "@playwright/test";

import { pikosCli } from "./cli";
import {
  test as appTest,
  bridgeCall,
  createFolder,
  dayFrom,
  expect,
  mod,
  quickAdd,
  seedSynced,
  stamp,
  WRITE_QUEUE_DEBOUNCE_MS,
} from "./fixtures";

/** Schedule a page by clicking a day in its date picker: Quick Add has no past dates. */
async function scheduleOnPickerDay(app: Page, title: string, offset: number) {
  const { picker: day } = await dayFrom(app, offset);
  await app.locator("[data-page-list-item]").filter({ hasText: title }).click();
  await app.getByRole("button", { name: /^(Set schedule|Scheduled: )/ }).click();
  const dialog = app.getByRole("dialog", { name: "Schedule picker" });
  const cell = dialog.getByRole("button", { exact: true, name: day });
  if (!(await cell.isVisible()))
    await dialog.getByRole("button", { name: "Previous month" }).click();
  await cell.click();
  await app.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
}

async function expandOverdue(app: Page) {
  const header = app.getByRole("button", { name: /^Overdue/ });
  if ((await header.getAttribute("aria-expanded")) !== "true") await header.click();
  await expect(header).toHaveAttribute("aria-expanded", "true");
  return header;
}

async function firstLines(app: Page) {
  return (await app.locator("[data-page-list-item]").allInnerTexts()).map(
    (t) => t.trim().split("\n")[0]!
  );
}

appTest(
  "a manual order set by dragging survives a relaunch",
  { tag: ["@LIST-08"] },
  async ({ app, storage }) => {
    appTest.skip(
      storage !== "bridge",
      "LIST-08 reloads, and the mock keeps nothing across a reload"
    );
    for (const title of ["alpha task", "bravo task", "charlie task"]) await quickAdd(app, title);
    const items = app.locator("[data-page-list-item]");
    let order: string[] = [];

    await appTest.step("LIST-08 a drag in Manual order moves the page", async () => {
      await app.getByRole("button", { name: /^Sort:/ }).click();
      await app.getByRole("menuitem", { name: "Manual" }).click();
      await expect(app.getByRole("button", { name: "Sort: manual" })).toBeVisible();
      await expect(items).toHaveCount(3);
      const before = (await items.allInnerTexts()).map((t) => t.trim().split("\n")[0]!);

      const source = await items.last().boundingBox();
      const target = await items.first().boundingBox();
      if (!source || !target) throw new Error("page rows have no boxes");
      await app.mouse.move(source.x + source.width / 2, source.y + source.height / 2);
      await app.mouse.down();
      await app.mouse.move(source.x + source.width / 2 + 16, source.y + source.height / 2, {
        steps: 4,
      });
      await app.mouse.move(target.x + target.width / 2, target.y + 4, { steps: 10 });
      await app.mouse.up();

      await expect
        .poll(async () => (await items.first().innerText()).trim().split("\n")[0])
        .toBe(before[before.length - 1]);
      order = (await items.allInnerTexts()).map((t) => t.trim().split("\n")[0]!);
    });

    await appTest.step("LIST-08 after a relaunch the order sticks", async () => {
      await app.reload();
      await expect(app.getByRole("main", { name: "Workspace" })).toBeVisible();
      await expect(items).toHaveCount(3);
      const after = (await items.allInnerTexts()).map((t) => t.trim().split("\n")[0]!);
      expect(after).toEqual(order);
    });
  }
);

appTest(
  "Space on a mixed selection completes the plain pages and advances the recurring one",
  { tag: ["@LIST-10"] },
  async ({ app }) => {
    await quickAdd(app, "plain one");
    await quickAdd(app, "plain two");
    await quickAdd(app, "standup every day");
    const list = app.locator("[data-page-list-item]");
    const standup = list.filter({ hasText: "standup" });
    const schedule = (day: string) => app.getByRole("button", { name: `Scheduled: ${day}` });

    await standup.click();
    await expect(schedule("Today")).toBeVisible();

    await appTest.step("LIST-10 Space completes every selected plain page", async () => {
      await app.locator("body").click({ position: { x: 0, y: 0 } });
      await app.keyboard.press(mod("Mod+a"));
      await expect(app.locator("[data-page-list-item][data-selected=true]")).toHaveCount(3);
      await app.keyboard.press("Space");

      await expect(list.filter({ hasText: "plain one" })).not.toBeVisible();
      await expect(list.filter({ hasText: "plain two" })).not.toBeVisible();
      await app.getByRole("button", { name: /^Completed/ }).click();
      for (const title of ["plain one", "plain two"]) {
        await expect(
          list.filter({ hasText: title }).getByRole("checkbox", { name: /Mark not done/i })
        ).toBeVisible();
      }
    });

    await appTest.step("LIST-10 the recurring page advances exactly one occurrence", async () => {
      const head = standup.filter({ has: app.getByRole("checkbox", { name: /^Mark done/i }) });
      await expect(head).toHaveCount(1);
      await head.click();
      await expect(schedule("Tomorrow")).toBeVisible();
    });
  }
);

appTest(
  "arrows move the selection and open the page, and Enter opens a focused row",
  { tag: ["@LIST-01:2"] },
  async ({ app }) => {
    for (const title of ["north page", "middle page", "south page"]) await quickAdd(app, title);
    const list = app.locator("[data-page-list-item]");
    const title = app.getByLabel("Page title");
    const order = await firstLines(app);

    await appTest.step(
      "LIST-01 Arrow Down and Up move the selection and open each page",
      async () => {
        await list.filter({ hasText: order[0]! }).click();
        await expect(title).toHaveText(order[0]!);
        await app.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
        await app.keyboard.press("ArrowDown");
        await expect(title).toHaveText(order[1]!);
        await expect(list.filter({ hasText: order[1]! })).toHaveAttribute("data-active", "true");
        await app.keyboard.press("ArrowUp");
        await expect(title).toHaveText(order[0]!);
      }
    );

    await appTest.step("LIST-01 Enter on a focused row opens it", async () => {
      await list.filter({ hasText: order[2]! }).focus();
      await expect(title).toHaveText(order[0]!);
      await app.keyboard.press("Enter");
      await expect(title).toHaveText(order[2]!);
    });
  }
);

appTest(
  "Upcoming groups today and the next six days, and leaves overdue pages to Today",
  { tag: ["@LIST-03"] },
  async ({ app }) => {
    const today = await dayFrom(app, 0);
    const inThree = await dayFrom(app, 3);
    const inSeven = await dayFrom(app, 7);
    await quickAdd(app, "late check-in @today at 11:58pm");
    await quickAdd(app, "design review @tomorrow at 9am");
    await quickAdd(app, `quarter retro on ${inThree.monthDay}`);
    await quickAdd(app, `far review on ${inSeven.monthDay}`);
    await quickAdd(app, "missed invoice");
    await scheduleOnPickerDay(app, "missed invoice", -1);
    const list = app.getByRole("group", { name: "Upcoming" });
    const items = app.locator("[data-page-list-item]");

    await app.getByRole("button", { name: /^Upcoming/ }).click();

    await appTest.step("LIST-03 each of the next days has its own header", async () => {
      await expect(list.getByText(/^Today/)).toBeVisible();
      await expect(list.getByText(/^Tomorrow/)).toBeVisible();
      await expect(list.getByText(new RegExp(`^${inThree.header}`))).toBeVisible();
      await expect(items.filter({ hasText: "late check-in" })).toBeVisible();
      await expect(items.filter({ hasText: "design review" })).toBeVisible();
      await expect(items.filter({ hasText: "quarter retro" })).toBeVisible();
    });

    await appTest.step("LIST-03 a page a week out falls outside the window", async () => {
      await expect(items.filter({ hasText: "far review" })).toHaveCount(0);
      expect(today.header).not.toBe(inSeven.header);
    });

    await appTest.step("LIST-03 an overdue page is left to Today", async () => {
      await expect(items.filter({ hasText: "missed invoice" })).toHaveCount(0);
      await app.getByRole("button", { name: /^Today/ }).click();
      await expandOverdue(app);
      await expect(items.filter({ hasText: "missed invoice" })).toBeVisible();
    });
  }
);

appTest(
  "Overdue holds only earlier days, and Move to today moves plain pages and names what it leaves",
  { tag: ["@LIST-04"] },
  async ({ app }) => {
    await seedSynced(app);
    await quickAdd(app, "call the landlord");
    await scheduleOnPickerDay(app, "call the landlord", -1);
    // On yesterday's weekday, so yesterday is one of its dates: a daily series would
    // also have today's, and a head moved off its rule snaps forward (PKOS-0029).
    await quickAdd(app, `water the plants every ${(await dayFrom(app, -1)).weekday}`);
    await scheduleOnPickerDay(app, "water the plants", -1);
    await quickAdd(app, "early sync @today at 12:05am");
    const items = app.locator("[data-page-list-item]");
    await app.getByRole("button", { name: /^Today/ }).click();
    const overdue = await expandOverdue(app);

    await appTest.step("LIST-04 Overdue holds the earlier days and not today's page", async () => {
      for (const title of ["call the landlord", "water the plants", "Budget sign-off"]) {
        await expect(items.filter({ hasText: title })).toBeVisible();
      }
      await overdue.click();
      await expect(overdue).toHaveAttribute("aria-expanded", "false");
      for (const title of ["call the landlord", "water the plants", "Budget sign-off"]) {
        await expect(items.filter({ hasText: title })).toHaveCount(0);
      }
      await expect(items.filter({ hasText: "early sync" })).toBeVisible();
      await overdue.click();
    });

    await appTest.step(
      "LIST-04 Move to today moves the plain page and names the rest",
      async () => {
        await app.getByRole("button", { name: "Move to today" }).click();
        await expect(
          app.getByRole("alert", { name: /^Moved 1 · 1 recurring, \d+ synced left$/ })
        ).toBeVisible();
        await overdue.click();
        await expect(overdue).toHaveAttribute("aria-expanded", "false");
        await expect(items.filter({ hasText: "call the landlord" })).toBeVisible();
        await expect(items.filter({ hasText: "water the plants" })).toHaveCount(0);
        await expect(items.filter({ hasText: "Budget sign-off" })).toHaveCount(0);
      }
    );
  }
);

appTest(
  "folders are created, renamed, recolored, reordered, deleted and jumped to by position",
  { tag: ["@LIST-06"] },
  async ({ app }) => {
    const sidebar = app.getByRole("group", { name: "Views and folders" });
    const folder = (name: string) => sidebar.getByRole("button", { exact: true, name });
    const folderRows = sidebar.getByRole("button").filter({ has: app.getByTestId("folder-color") });
    const folderOrder = async () => {
      const names: string[] = [];
      for (const row of await folderRows.all())
        names.push((await row.getAttribute("aria-label")) ?? "");
      return names;
    };

    await appTest.step("LIST-06 a folder is created inline", async () => {
      await createFolder(app, "Errands");
      await expect(folder("Errands")).toHaveAttribute("aria-current", "true");
    });

    await appTest.step("LIST-06 it is renamed from its menu", async () => {
      await folder("Errands").click({ button: "right" });
      await app.getByRole("menuitem", { name: "Rename" }).click();
      await expect(sidebar.getByRole("textbox")).toBeFocused();
      await app.keyboard.press(mod("Mod+a"));
      await app.keyboard.type("Chores");
      await app.keyboard.press("Enter");
      await expect(folder("Chores")).toBeVisible();
      await expect(folder("Errands")).toHaveCount(0);
    });

    await appTest.step("LIST-06 it is recolored from its menu", async () => {
      await folder("Chores").click({ button: "right" });
      await app.getByRole("menuitem", { name: "Color" }).hover();
      await app.getByRole("menuitem", { name: "Red" }).click();
      await expect(folder("Chores").getByTestId("folder-color")).toHaveCSS(
        "background-color",
        "rgb(229, 83, 75)"
      );
    });

    await createFolder(app, "Admin");
    await createFolder(app, "Garden");

    await appTest.step("LIST-06 a drag reorders the folders", async () => {
      const before = await folderOrder();
      const from = await folder(before[2]!).boundingBox();
      const to = await folder(before[0]!).boundingBox();
      if (!from || !to) throw new Error("folder rows have no boxes");
      await app.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
      await app.mouse.down();
      await app.mouse.move(from.x + from.width / 2, from.y + from.height / 2 - 16, { steps: 4 });
      await app.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 10 });
      await app.mouse.up();
      await expect.poll(folderOrder).not.toEqual(before);
      expect([...(await folderOrder())].sort()).toEqual([...before].sort());
    });

    await appTest.step("LIST-06 Cmd+1 to Cmd+3 jump to the folder in that position", async () => {
      const order = await folderOrder();
      await app.getByRole("button", { name: /^Inbox/ }).click();
      for (const [i, name] of order.entries()) {
        await app.keyboard.press(mod(`Mod+${i + 1}`));
        await expect(folder(name)).toHaveAttribute("aria-current", "true");
      }
    });

    await appTest.step(
      "LIST-06 deleting a folder names its page count outside the quotes",
      async () => {
        await folder("Chores").click();
        await quickAdd(app, "buy bulbs");
        await quickAdd(app, "fix the gate");
        await folder("Chores").click({ button: "right" });
        await app.getByRole("menuitem", { name: "Delete" }).click();
        await expect(
          app.getByRole("alert", { name: "Deleted “Chores” and 2 pages" })
        ).toBeVisible();
        await expect(folder("Chores")).toHaveCount(0);
      }
    );
  }
);

appTest(
  "the sort menu reorders each view on its own, survives relaunch, and is absent on date views",
  { tag: ["@LIST-07:3"] },
  async ({ app, storage }) => {
    appTest.skip(
      storage !== "bridge",
      "LIST-07 reloads, and the mock keeps nothing across a reload"
    );
    const sortChip = app.getByRole("button", { name: /^Sort:/ });
    async function sortBy(mode: "Date" | "Title" | "Priority" | "Manual") {
      await sortChip.click();
      await app.getByRole("menuitem", { name: mode }).click();
      await expect(app.getByRole("button", { name: `Sort: ${mode.toLowerCase()}` })).toBeVisible();
    }

    await quickAdd(app, "charlie idea !low");
    await quickAdd(app, "alpha idea !1");
    await quickAdd(app, "bravo idea @tomorrow");
    await createFolder(app, "Work");
    await quickAdd(app, "zulu task !low");
    await quickAdd(app, "yankee task !1");
    const inbox = app.getByRole("button", { name: /^Inbox/ });
    const work = app.getByRole("group", { name: "Views and folders" }).getByRole("button", {
      exact: true,
      name: "Work",
    });

    await appTest.step("LIST-07 Title, Priority and Date each reorder the list", async () => {
      await inbox.click();
      await sortBy("Title");
      expect(await firstLines(app)).toEqual(["alpha idea", "bravo idea", "charlie idea"]);
      await sortBy("Priority");
      expect((await firstLines(app))[0]).toBe("alpha idea");
      await sortBy("Date");
      expect((await firstLines(app))[0]).toBe("bravo idea");
      await sortBy("Title");
    });

    await appTest.step("LIST-07 each view keeps its own choice", async () => {
      await work.click();
      await expect(app.getByRole("button", { name: "Sort: manual" })).toBeVisible();
      await sortBy("Priority");
      expect(await firstLines(app)).toEqual(["yankee task", "zulu task"]);
      await inbox.click();
      await expect(app.getByRole("button", { name: "Sort: title" })).toBeVisible();
    });

    await appTest.step("LIST-07 both choices survive a relaunch", async () => {
      await app.waitForTimeout(2 * WRITE_QUEUE_DEBOUNCE_MS);
      await app.reload();
      await expect(app.getByRole("main", { name: "Workspace" })).toBeVisible();
      await inbox.click();
      await expect(app.getByRole("button", { name: "Sort: title" })).toBeVisible();
      expect(await firstLines(app)).toEqual(["alpha idea", "bravo idea", "charlie idea"]);
      await work.click();
      await expect(app.getByRole("button", { name: "Sort: priority" })).toBeVisible();
    });

    await appTest.step("LIST-07 Today and Upcoming have no sort menu", async () => {
      await app.getByRole("button", { name: /^Today/ }).click();
      await expect(sortChip).toHaveCount(0);
      await app.getByRole("button", { name: /^Upcoming/ }).click();
      await expect(sortChip).toHaveCount(0);
    });
  }
);

appTest(
  "Completed collapses on every view change, and loads more on request",
  { tag: ["@LIST-11:2"] },
  async ({ app, storage }) => {
    appTest.skip(
      storage !== "bridge",
      "LIST-11 reloads, and the mock keeps nothing across a reload"
    );
    // One more than a batch, completed before the relaunch, so the batch can't hold them all.
    for (let i = 1; i <= 21; i++) await quickAdd(app, `done item ${i}`);
    await app.locator("body").click({ position: { x: 0, y: 0 } });
    await app.keyboard.press(mod("Mod+a"));
    await app.keyboard.press("Space");
    await expect(app.locator("[data-page-list-item]")).toHaveCount(0);
    await app.waitForTimeout(2 * WRITE_QUEUE_DEBOUNCE_MS);
    await app.reload();
    await expect(app.getByRole("main", { name: "Workspace" })).toBeVisible();

    const completed = app.getByRole("button", { exact: true, name: "Completed" });
    const showMore = app.getByRole("button", { name: "Show more completed" });

    await appTest.step("LIST-11 expanding loads completed pages", async () => {
      await completed.click();
      await expect(completed).toHaveAttribute("aria-expanded", "true");
      await expect(app.locator("[data-page-list-item]").first()).toContainText("done item");
    });

    await appTest.step("LIST-11 Show more completed loads the rest", async () => {
      await showMore.scrollIntoViewIfNeeded();
      await showMore.click();
      await expect(showMore).toHaveCount(0);
    });

    await appTest.step("LIST-11 it is collapsed again after a view change", async () => {
      await app.getByRole("button", { name: /^Today/ }).click();
      await app.getByRole("button", { name: /^Inbox/ }).click();
      await expect(completed).toHaveAttribute("aria-expanded", "false");
      await expect(app.locator("[data-page-list-item]")).toHaveCount(0);
    });
  }
);

appTest(
  "a page's menu offers Rename, Move to folder, No date and Delete, and counts a selection",
  { tag: ["@LIST-12"] },
  async ({ app }) => {
    await quickAdd(app, "dated page @tomorrow");
    await quickAdd(app, "other page");
    const items = app.locator("[data-page-list-item]");
    const dated = items.filter({ hasText: "dated page" });

    await appTest.step("LIST-12 one scheduled page offers all four", async () => {
      await dated.click({ button: "right" });
      for (const name of ["Rename", "Move to folder", "No date", "Delete"]) {
        await expect(app.getByRole("menuitem", { exact: true, name })).toBeVisible();
      }
    });

    await appTest.step("LIST-12 No date clears the date", async () => {
      await app.getByRole("menuitem", { exact: true, name: "No date" }).click();
      await dated.click({ button: "right" });
      await expect(app.getByRole("menuitem", { exact: true, name: "No date" })).toHaveCount(0);
      await app.keyboard.press("Escape");
    });

    await appTest.step("LIST-12 with two selected it reads and does Delete 2 pages", async () => {
      await dated.click();
      await items.filter({ hasText: "other page" }).click({ modifiers: ["ControlOrMeta"] });
      await expect(app.locator("[data-page-list-item][data-selected=true]")).toHaveCount(2);
      await dated.click({ button: "right" });
      const deleteBoth = app.getByRole("menuitem", { exact: true, name: "Delete 2 pages" });
      await expect(deleteBoth).toBeVisible();
      await expect(app.getByRole("menuitem", { name: "Rename" })).toHaveCount(0);
      await deleteBoth.click();
      await expect(items).toHaveCount(0);
    });
  }
);

appTest(
  "Cmd+\\ hides the sidebar, a narrow window gets the switcher, and the sidebar resizes and holds",
  { tag: ["@LIST-13"] },
  async ({ app }) => {
    const nav = app.getByRole("navigation", { name: "Workspace navigation" });
    const width = async () => (await nav.boundingBox())?.width ?? 0;

    await appTest.step(
      "LIST-13 the resize handle drags the sidebar wider, and it holds",
      async () => {
        const before = await width();
        const handle = await app.getByRole("separator", { name: "Resize sidebar" }).boundingBox();
        if (!handle) throw new Error("no resize handle");
        await app.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
        await app.mouse.down();
        await app.mouse.move(handle.x + 60, handle.y + handle.height / 2, { steps: 8 });
        await app.mouse.up();
        await expect.poll(width).toBeGreaterThan(before + 40);
        const dragged = await width();
        await app.reload();
        await expect(app.getByRole("main", { name: "Workspace" })).toBeVisible();
        await expect.poll(width).toBe(dragged);
      }
    );

    await appTest.step("LIST-13 Cmd+\\ hides the sidebar and brings it back", async () => {
      await app.keyboard.press(mod("Mod+\\"));
      await expect(app.getByRole("button", { name: "Expand sidebar" })).toBeVisible();
      await app.keyboard.press(mod("Mod+\\"));
      await expect(app.getByRole("button", { name: "Collapse sidebar" })).toBeVisible();
    });

    await appTest.step(
      "LIST-13 a window too narrow for the sidebar gets the switcher",
      async () => {
        const switcher = app.getByRole("button", { name: "Switch view" });
        await expect(switcher).toHaveCount(0);
        await app.setViewportSize({ height: 720, width: 900 });
        await switcher.click();
        await app
          .getByRole("dialog")
          .getByRole("button", { name: /^Today/ })
          .click();
        await expect(switcher).toContainText("Today");
      }
    );
  }
);

/** The seeded synced calendar, a native page yesterday and one just after midnight, and a synced
 *  event just after midnight, so today holds one of each that is already over. */
async function seedTodayAgreement(app: Page) {
  appTest.skip(
    new Date().getHours() === 0 && new Date().getMinutes() < 20,
    "the synced one-off has to be over"
  );
  await seedSynced(app);
  await quickAdd(app, "call the landlord");
  await scheduleOnPickerDay(app, "call the landlord", -1);
  await quickAdd(app, "early start @today at 12:05am");
  await bridgeCall(app, "upstream_sync", {
    calendar: "Personal",
    events: [
      {
        end: await stamp(app, 0, "00:15"),
        start: await stamp(app, 0, "00:05"),
        timezone: "America/New_York",
        title: "Dawn call",
      },
    ],
  });
  await app.setViewportSize({ height: 3000, width: 1400 });
  await app.reload();
  await app.getByRole("button", { name: /^Today/ }).click();
  const overdue = await expandOverdue(app);
  await expect(app.locator("[data-page-list-item]").filter({ hasText: "Dawn call" })).toBeVisible();
  return overdue;
}

appTest("Today lists what pikos today lists", { tag: ["@CLI-06"] }, async ({ app }) => {
  await seedTodayAgreement(app);
  const shown = await firstLines(app);

  const db = await bridgeCall<string>(app, "bridge_workspace_path");
  const cli = JSON.parse(
    execFileSync(pikosCli(), ["--db", db, "--json", "today"], { encoding: "utf8" })
  ) as { title: string }[];

  expect(cli.map((p) => p.title).sort()).toEqual([...shown].sort());
});

appTest(
  "the daily summary counts as many today as Today lists, past synced one-off included",
  { tag: ["@SYNC-27:3"] },
  async ({ app }) => {
    const overdue = await seedTodayAgreement(app);
    await overdue.click();
    await expect(overdue).toHaveAttribute("aria-expanded", "false");
    const today = await firstLines(app);
    expect(today).toContain("Dawn call");

    const summary = await bridgeCall<{ overdue: number; today: number } | null>(
      app,
      "bridge_daily_summary"
    );

    expect(summary?.today).toBe(today.length);
  }
);
