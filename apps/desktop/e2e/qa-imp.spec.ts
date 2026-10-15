import type { Page } from "@playwright/test";

import { test as appTest, bridgeCall, expect, quickAdd, seedSynced } from "./fixtures";

const VAULT = {
  files: [
    { content: "Quarterly planning notes.", path: "Projects/Work/Q3 plan.md" },
    { content: "---\nstatus: done\n---\nShipped.", path: "Projects/Work/Launch.md" },
    { content: "```mermaid\ngraph TD; A-->B\n```", path: "Personal/Diagram.md" },
  ],
  path: "/tmp/pikos-e2e-vault",
};

appTest(
  "the import preview shows the count, the folders, the warnings and a skip-completed toggle",
  { tag: ["@IMP-06"] },
  async ({ app }) => {
    await app.evaluate((vault) => {
      (window as unknown as Record<string, unknown>)["__PIKOS_TEST_VAULT__"] = vault;
    }, VAULT);
    await app.getByRole("button", { name: "Open settings" }).click();
    await app.getByRole("button", { exact: true, name: "Data" }).click();
    await app.getByRole("button", { name: /Select Folder/ }).click();
    await expect(app.getByRole("heading", { name: "Import Preview" })).toBeVisible();

    await appTest.step("IMP-06 it shows the page count", async () => {
      await expect(app.getByText(/3 pages in 2 folders/)).toBeVisible();
    });

    await appTest.step("IMP-06 it shows the folder hierarchy", async () => {
      await expect(app.getByRole("button", { name: "Projects / Work (2)" })).toBeVisible();
      await expect(app.getByRole("button", { name: "Personal (1)" })).toBeVisible();
    });

    await appTest.step("IMP-06 it shows the warnings", async () => {
      await expect(app.getByText("Import notes")).toBeVisible();
      await expect(app.getByText(/Contains unsupported content: mermaid diagram/)).toBeVisible();
    });

    await appTest.step("IMP-06 it offers to skip completed pages", async () => {
      await expect(app.getByRole("button", { name: /Import 3 pages/ })).toBeVisible();
      await app.getByRole("checkbox", { name: /Skip 1 completed/ }).check();
      await expect(app.getByRole("button", { name: /Import 2 pages/ })).toBeVisible();
    });
  }
);

type VaultFile = { content: string; path: string };

async function importVault(app: Page, files: VaultFile[]) {
  await app.evaluate((vault) => {
    (window as unknown as Record<string, unknown>)["__PIKOS_TEST_VAULT__"] = vault;
  }, { files, path: "/tmp/pikos-e2e-vault" });
  await app.getByRole("button", { name: "Open settings" }).click();
  await app.getByRole("button", { exact: true, name: "Data" }).click();
  await app.getByRole("button", { name: /Select Folder/ }).click();
  await expect(app.getByRole("heading", { name: "Import Preview" })).toBeVisible();
}

async function importCsv(app: Page, csv: string) {
  await app.evaluate((text) => {
    (window as unknown as Record<string, unknown>)["__PIKOS_TEST_CSV__"] = text;
  }, csv);
  await app.getByRole("button", { name: "Open settings" }).click();
  await app.getByRole("button", { exact: true, name: "Data" }).click();
  await app.getByRole("button", { name: /Select File/ }).click();
  await expect(app.getByRole("heading", { name: "Map CSV Columns" })).toBeVisible();
}

/** Settings closes itself once an import lands, sometimes a beat after the preview
 *  goes, so wait for it to be shut before a test opens it again. */
async function commitImport(app: Page, pages: number) {
  await app.getByRole("button", { name: new RegExp(`^Import ${pages} pages?`) }).click();
  await expect(app.getByRole("heading", { name: "Import Preview" })).not.toBeVisible();
  const settings = app.getByRole("region", { name: "Settings" });
  await expect(async () => {
    if (await settings.isVisible()) await app.keyboard.press("Escape");
    await expect(settings).not.toBeVisible({ timeout: 500 });
  }).toPass();
}

function folderRow(app: Page, name: string) {
  return app
    .getByRole("group", { name: "Views and folders" })
    .getByRole("button", { exact: true, name })
    .filter({ has: app.getByTestId("folder-color") });
}

/** Open a folder, retrying while an overlay closing over the sidebar eats the click. */
async function openFolder(app: Page, name: string) {
  await expect(async () => {
    await folderRow(app, name).click();
    await expect(folderRow(app, name)).toHaveAttribute("aria-current", "true", { timeout: 1000 });
  }).toPass();
}

function rowOf(app: Page, title: string) {
  return app.locator("[data-page-list-item]").filter({ hasText: title });
}

appTest(
  "Markdown frontmatter maps tags, status, priority and dates",
  { tag: ["@IMP-01"] },
  async ({ app }) => {
    await importVault(app, [
      {
        content:
          "---\ntags: [finance, home]\nstatus: done\npriority: high\ndue: 2026-11-20\ncreated: 2024-03-05\n---\nPaid in full.",
        path: "Finance/Mortgage.md",
      },
      {
        content: "---\nstatus: todo\npriority: low\n---\nStill to do.",
        path: "Finance/Insurance.md",
      },
    ]);
    await commitImport(app, 2);
    await openFolder(app, "Finance");

    await appTest.step("IMP-01 status maps both ways", async () => {
      await expect(rowOf(app, "Insurance")).toBeVisible();
      await expect(rowOf(app, "Mortgage")).toHaveCount(0);
      await app.getByRole("button", { exact: true, name: "Completed" }).click();
      await expect(rowOf(app, "Mortgage").getByRole("checkbox", { name: "Mark not done" })).toBeVisible();
    });

    await appTest.step("IMP-01 tags, priority and the due date land on the page", async () => {
      await rowOf(app, "Mortgage").click();
      await expect(app.getByRole("button", { name: /^Tags: (finance, home|home, finance)$/ })).toBeVisible();
      await expect(app.getByRole("button", { name: "Priority: High" })).toBeVisible();
      await expect(app.getByRole("button", { name: /^Scheduled: Nov 20/ })).toBeVisible();
    });

    await appTest.step("IMP-01 the created date is the file's, not today", async () => {
      await app.getByRole("button", { name: "Page info" }).click();
      await expect(app.getByRole("dialog")).toContainText("Mar 5, 2024");
    });
  }
);

const TICKTICK_EXPORT = `"Date: 2026-09-30+0000"
"Version: 7.1"
"Status: 
0 Normal
1 Completed
2 Archived"
"Folder Name","List Name","Title","Kind","Tags","Content","Is Check list","Start Date","Due Date","Reminder","Repeat","Priority","Status","Created Time","Completed Time","Order","Timezone","Is All Day","Is Floating","Column Name","Column Order","View Mode","taskId","parentId"
"","Garden","Plant bulbs","TEXT","","Tulips by the fence","N","","","","","0","0","2026-09-01T10:00:00+0000","","0","America/New_York","false","false","","","list","1",""
"","Garden","Water daily","TEXT","","","N","","","","","0","0","2026-09-01T10:00:00+0000","","0","America/New_York","false","false","","","list","2","1"`;

const TODOIST_EXPORT = `TYPE,CONTENT,DESCRIPTION,PRIORITY,INDENT,AUTHOR,RESPONSIBLE,DATE,DATE_LANG,TIMEZONE,DURATION,DURATION_UNIT,DEADLINE,DEADLINE_LANG
meta,view_style=list,,,,,,,,,,,,
task,Weekly chores,,4,1,,,,,,,,,
task,Clean the house,,4,2,,,,,,,,,
task,Take out the trash,,3,2,,,,,,,,,
task,Call the plumber,,1,1,,,,,,,,,`;

appTest(
  "real vault and export shapes import with flat folder names, silent title-only pages, and nesting",
  { tag: ["@IMP-02"] },
  async ({ app, storage }) => {
    appTest.skip(storage !== "bridge", "IMP-02 reads the stored parent, which only the writer holds");

    await appTest.step("IMP-02 a vault's nested folders flatten, and a title-only file imports quietly", async () => {
      await importVault(app, [
        { content: "Quarterly goals.", path: "Projects/Work/Plan.md" },
        { content: "", path: "Projects/Work/Just a title.md" },
        { content: "Loose thought.", path: "Inbox note.md" },
      ]);
      await expect(app.getByText(/3 pages in/)).toBeVisible();
      await expect(app.getByRole("button", { name: "Projects / Work (2)" })).toBeVisible();
      // The only note is the folder flattening; the title-only file raises none.
      await expect(app.getByRole("listitem").filter({ hasText: /Just a title|empty/i })).toHaveCount(0);
      await commitImport(app, 3);
      await openFolder(app, "Projects / Work");
      await expect(app.locator("[data-page-list-item]")).toHaveCount(2);
      await expect(rowOf(app, "Just a title")).toBeVisible();
    });

    await appTest.step("IMP-02 a TickTick export's preamble is stripped and it is detected", async () => {
      await importCsv(app, TICKTICK_EXPORT);
      await expect(app.getByText(/Auto-detected as TickTick/)).toBeVisible();
      await app.getByRole("button", { name: "Continue" }).click();
      await commitImport(app, 2);
      await openFolder(app, "Garden");
      await expect(rowOf(app, "Plant bulbs")).toBeVisible();
      await expect(rowOf(app, "Water daily")).toBeVisible();
    });

    await appTest.step("IMP-02 a Todoist export's subtasks nest under their task", async () => {
      await importCsv(app, TODOIST_EXPORT);
      await expect(app.getByText(/Auto-detected as Todoist/)).toBeVisible();
      await app.getByRole("button", { name: "Continue" }).click();
      await commitImport(app, 4);
      await app.getByRole("button", { name: /^Inbox/ }).click();
      const idOf = async (title: string) => (await rowOf(app, title).getAttribute("data-page-id")) ?? "";
      const parent = await idOf("Weekly chores");
      for (const child of ["Clean the house", "Take out the trash"]) {
        const page = await bridgeCall<{ parentId: string | null }>(app, "get_page", { id: await idOf(child) });
        expect(page.parentId).toBe(parent);
      }
      const top = await bridgeCall<{ parentId: string | null }>(app, "get_page", {
        id: await idOf("Call the plumber"),
      });
      expect(top.parentId).toBeNull();
    });
  }
);

appTest(
  "a vault with mermaid, dataview and callouts warns and still imports",
  { tag: ["@IMP-04"] },
  async ({ app }) => {
    await importVault(app, [
      { content: "```mermaid\ngraph TD; A-->B\n```", path: "Diagram.md" },
      { content: "```dataview\nTABLE file.name\n```", path: "Index.md" },
      { content: "> [!note] Remember\n> Bring the keys.", path: "Callout.md" },
    ]);

    await appTest.step("IMP-04 the preview warns about what it can't carry", async () => {
      await expect(app.getByText("Import notes")).toBeVisible();
      await expect(app.getByText(/unsupported content: mermaid diagram/)).toBeVisible();
      await expect(app.getByText(/unsupported content: dataview query/)).toBeVisible();
    });

    await appTest.step("IMP-04 the import still completes, the callout as a quote", async () => {
      await commitImport(app, 3);
      for (const title of ["Diagram", "Index", "Callout"]) await expect(rowOf(app, title)).toBeVisible();
      await rowOf(app, "Callout").click();
      await expect(
        app.getByRole("textbox", { name: "Page content" }).getByRole("blockquote")
      ).toContainText("Bring the keys");
    });
  }
);

appTest(
  "a generic CSV maps columns and values by hand, and Created At maps itself",
  { tag: ["@IMP-05"] },
  async ({ app }) => {
    await importCsv(
      app,
      `Name,Notes,State,Importance,Created At
Fix the gate,Hinge is loose,Finished,Hot,2024-02-01
Paint the shed,,Waiting,Meh,2024-02-02`
    );
    const column = (header: string) => app.getByRole("combobox", { name: `Map column ${header}` });

    await appTest.step("IMP-05 Created At maps to the created date on its own", async () => {
      await expect(column("Created At")).toHaveValue("createdAt");
    });

    await appTest.step("IMP-05 columns map by hand", async () => {
      await column("Name").selectOption("title");
      await column("Notes").selectOption("body");
      await column("State").selectOption("status");
      await column("Importance").selectOption("priority");
    });

    await appTest.step("IMP-05 status and priority values map by hand", async () => {
      await app.getByRole("combobox", { name: "Map status value Finished" }).selectOption("done");
      await app.getByRole("combobox", { name: "Map status value Waiting" }).selectOption("not_started");
      await app.getByRole("combobox", { name: "Map priority value Hot" }).selectOption("1");
      await app.getByRole("combobox", { name: "Map priority value Meh" }).selectOption("4");
      await app.getByRole("button", { name: "Continue" }).click();
      await commitImport(app, 2);
    });

    await appTest.step("IMP-05 the pages carry the mapped values", async () => {
      await expect(rowOf(app, "Paint the shed")).toBeVisible();
      await rowOf(app, "Paint the shed").click();
      await expect(app.getByRole("button", { name: "Priority: Low" })).toBeVisible();
      await app.getByRole("button", { name: "Page info" }).click();
      await expect(app.getByRole("dialog")).toContainText("Feb 2, 2024");
      await app.keyboard.press("Escape");
      await app.getByRole("button", { exact: true, name: "Completed" }).click();
      await rowOf(app, "Fix the gate").click();
      await expect(app.getByRole("button", { name: "Priority: Urgent" })).toBeVisible();
      await expect(app.getByRole("textbox", { name: "Page content" })).toHaveText("Hinge is loose");
    });
  }
);

appTest(
  "an import leaves a Before an import snapshot in Restore, and a cancel leaves none",
  { tag: ["@IMP-07"] },
  async ({ app, storage }) => {
    appTest.skip(storage !== "bridge", "snapshots are the writer's files, which the mock has none of");
    const snapshot = app.getByText("Before an import");

    await appTest.step("IMP-07 a cancelled import writes nothing and takes no snapshot", async () => {
      await importVault(app, [{ content: "Hello.", path: "Note.md" }]);
      await app.getByRole("button", { exact: true, name: "Cancel" }).click();
      await expect(app.getByRole("heading", { name: "Import Preview" })).not.toBeVisible();
      await expect(snapshot).toHaveCount(0);
    });

    await appTest.step("IMP-07 a run import leaves one, listed as Before an import", async () => {
      await app.keyboard.press("Escape");
      await importVault(app, [{ content: "Hello.", path: "Note.md" }]);
      await commitImport(app, 1);
      await app.getByRole("button", { name: "Open settings" }).click();
      await app.getByRole("button", { exact: true, name: "Data" }).click();
      await expect(snapshot).toBeVisible();
    });
  }
);

appTest(
  "Undo import soft-deletes the whole batch without stranding the editor",
  { tag: ["@IMP-08"] },
  async ({ app }) => {
    await quickAdd(app, "kept page");
    await importVault(app, [
      { content: "One.", path: "Batch/First.md" },
      { content: "Two.", path: "Batch/Second.md" },
    ]);
    await commitImport(app, 2);
    await openFolder(app, "Batch");
    await rowOf(app, "First").click();
    await expect(app.getByLabel("Page title")).toHaveText("First");

    await appTest.step("IMP-08 Undo import takes every imported page", async () => {
      await app.getByRole("button", { name: "Open settings" }).click();
      await app.getByRole("button", { exact: true, name: "Data" }).click();
      await app.getByRole("button", { name: "Undo import" }).click();
      await app.keyboard.press("Escape");
      await expect(folderRow(app, "Batch")).toHaveCount(0);
      await app.getByRole("button", { exact: true, name: "Trash" }).click();
      await expect(app.getByRole("list", { name: "Deleted pages" })).toContainText("First");
      await expect(app.getByRole("list", { name: "Deleted pages" })).toContainText("Second");
    });

    await appTest.step("IMP-08 the editor lets go of the page it had open", async () => {
      await app.getByRole("button", { name: /^Inbox/ }).click();
      await expect(app.getByLabel("Page title").filter({ hasText: "First" })).toHaveCount(0);
      await expect(rowOf(app, "kept page")).toBeVisible();
    });
  }
);

appTest(
  "a vault folder named like a connected calendar imports beside it, not into it",
  { tag: ["@IMP-10"] },
  async ({ app }) => {
    await seedSynced(app);
    // The seed has a regular Work folder as well, which an import would simply reuse.
    await folderRow(app, "Work").click({ button: "right" });
    await app.getByRole("menuitem", { name: "Delete" }).click();
    await expect(folderRow(app, "Work")).toHaveCount(0);
    await importVault(app, [{ content: "Agenda.", path: "Work/Meeting notes.md" }]);
    await commitImport(app, 1);

    await appTest.step("IMP-10 a regular Work folder is made beside the calendar's", async () => {
      await expect(folderRow(app, "Work")).toHaveCount(1);
      await expect(
        app.getByRole("group", { name: "Views and folders" }).getByRole("button", { exact: true, name: "Work" })
      ).toHaveCount(2);
      await openFolder(app, "Work");
      await expect(rowOf(app, "Meeting notes")).toBeVisible();
    });
  }
);
