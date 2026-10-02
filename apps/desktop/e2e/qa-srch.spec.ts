import type { Page } from "@playwright/test";

import {
  test as appTest,
  createFolder,
  expect,
  mod,
  openEditorForPage,
  quickAdd,
} from "./fixtures";

function paletteOf(app: Page) {
  return app.getByRole("dialog", { name: "Search pages" });
}

/** Open the palette and fill it: filled, not typed, since a reopened palette can
 *  take keys before its field has focus. */
async function search(app: Page, query: string) {
  await app.keyboard.press(mod("Mod+k"));
  const palette = paletteOf(app);
  await expect(palette).toBeVisible();
  await palette.getByPlaceholder("Search pages, or > for commands…").fill(query);
  return palette;
}

/** A result row: its name runs on into its date or folder, so match the title's start. */
function result(app: Page, title: string) {
  return paletteOf(app).getByRole("button", { name: new RegExp(`^${title}( |$)`) });
}

appTest(
  "search ranks title matches first, highlights the match in a preview, and opens the choice",
  { tag: ["@SRCH-01"] },
  async ({ app }) => {
    await quickAdd(app, "zeppelin notes");
    await quickAdd(app, "summer travel");
    const body = await openEditorForPage(app, "summer travel");
    await app.keyboard.type("We took a zeppelin over the lake");
    await expect(body).toContainText("zeppelin");

    await appTest.step("SRCH-01 the title match ranks above the body match", async () => {
      const palette = await search(app, "zeppelin");
      const rows = palette.getByRole("button", { name: /^(zeppelin notes|summer travel)/ });
      await expect(rows).toHaveCount(2);
      await expect(rows.first()).toHaveAccessibleName(/^zeppelin notes/);
    });

    await appTest.step(
      "SRCH-01 the body match shows a preview with the word highlighted",
      async () => {
        const row = result(app, "summer travel");
        await expect(row).toContainText("took a");
        await expect(row.locator("mark")).toHaveText(["zeppelin"]);
      }
    );

    await appTest.step("SRCH-01 a description match shows the description highlighted", async () => {
      await quickAdd(app, "budget plan");
      await openEditorForPage(app, "budget plan");
      await app.getByRole("button", { name: "Page description" }).click();
      await app.getByRole("textbox", { name: "Page description" }).fill("Review the harbour lease");
      await app.keyboard.press("Enter");
      await search(app, "harbour");
      const row = result(app, "budget plan");
      await expect(row).toContainText("Review the");
      await expect(row.locator("mark")).toHaveText(["harbour"]);
      await app.keyboard.press("Escape");
      await search(app, "zeppelin");
    });

    await appTest.step("SRCH-01 choosing a result opens it", async () => {
      await result(app, "summer travel").click();
      await expect(paletteOf(app)).not.toBeVisible();
      await expect(app.getByLabel("Page title")).toHaveText("summer travel");
    });
  }
);

appTest("an empty palette lists recent pages", { tag: ["@SRCH-02"] }, async ({ app }) => {
  await quickAdd(app, "harbour plan");
  await quickAdd(app, "garden plan");
  await openEditorForPage(app, "harbour plan");
  await openEditorForPage(app, "garden plan");

  await appTest.step("SRCH-02 the page opened before this one is listed", async () => {
    const palette = await search(app, "");
    await expect(result(app, "harbour plan")).toBeVisible();
    await expect(palette.getByText("No recent pages")).toHaveCount(0);
  });
});

appTest(
  "a new page's words, and its edited words, are findable straight away",
  { tag: ["@SRCH-03"] },
  async ({ app }) => {
    await quickAdd(app, "shipping log");
    const body = await openEditorForPage(app, "shipping log");

    await appTest.step("SRCH-03 new body words are found at once", async () => {
      await app.keyboard.type("quixotic lighthouse keeper");
      await search(app, "lighthouse");
      await expect(result(app, "shipping log")).toBeVisible();
      await app.keyboard.press("Escape");
    });

    await appTest.step("SRCH-03 an edit is found by its new words, not its old ones", async () => {
      await body.click();
      await app.keyboard.press(mod("Mod+a"));
      await app.keyboard.type("windmill miller");
      await search(app, "windmill");
      await expect(result(app, "shipping log")).toBeVisible();
      await paletteOf(app).getByPlaceholder("Search pages, or > for commands…").fill("lighthouse");
      await expect(result(app, "shipping log")).toHaveCount(0);
      await app.keyboard.press("Escape");
    });
  }
);

appTest(
  "operators narrow alone and together, compose with free text, and fall back when unknown",
  { tag: ["@SRCH-04"] },
  async ({ app }) => {
    await createFolder(app, "Work");
    await quickAdd(app, "alpha audit #ledger !high today");
    await quickAdd(app, "beta audit #ledger");
    await app.getByRole("button", { name: /^Inbox/ }).click();
    await quickAdd(app, "gamma audit !high");
    await quickAdd(app, "banana priority review");
    await quickAdd(app, "priority checklist");
    const expectResults = async (query: string, titles: string[]) => {
      await search(app, query);
      for (const title of ["alpha audit", "beta audit", "gamma audit"]) {
        await expect(result(app, title)).toHaveCount(titles.includes(title) ? 1 : 0);
      }
      await app.keyboard.press("Escape");
    };

    await appTest.step("SRCH-04 each operator narrows on its own", async () => {
      await expectResults("tag:ledger", ["alpha audit", "beta audit"]);
      await expectResults("folder:Work", ["alpha audit", "beta audit"]);
      await expectResults("priority:high", ["alpha audit", "gamma audit"]);
      await expectResults("due:today", ["alpha audit"]);
      await expectResults("is:open audit", ["alpha audit", "beta audit", "gamma audit"]);
    });

    await appTest.step("SRCH-04 operators compose, and with free text", async () => {
      await expectResults("tag:ledger priority:high", ["alpha audit"]);
      await expectResults("folder:Work beta", ["beta audit"]);
    });

    await appTest.step("SRCH-04 an unknown value falls back to free text", async () => {
      await search(app, "priority:banana");
      await expect(result(app, "banana priority review")).toBeVisible();
      await expect(result(app, "priority checklist")).toHaveCount(0);
      await app.keyboard.press("Escape");
    });
  }
);

appTest(
  "every command the palette lists does what its label says",
  { tag: ["@SRCH-05"] },
  async ({ app }) => {
    await quickAdd(app, "alpha page today");
    await quickAdd(app, "beta page");
    const editor = await openEditorForPage(app, "alpha page");
    const rows = app.locator("[data-page-list-item]");
    const title = app.getByLabel("Page title");
    const fontSize = () => editor.evaluate((el) => getComputedStyle(el).fontSize);

    async function run(label: string) {
      await app.locator("body").click({ position: { x: 0, y: 0 } });
      const palette = await search(app, `>${label}`);
      await palette
        .getByRole("button", { name: new RegExp(`^${label}`) })
        .first()
        .click();
      await expect(palette).not.toBeVisible();
    }

    const expectations: Record<string, () => Promise<void>> = {
      "Close page": async () => {
        await run("Close page");
        await expect(title).toHaveCount(0);
        await rows.filter({ hasText: "alpha page" }).click();
      },
      "Decrease text size": async () => {
        await run("Increase text size");
        await run("Decrease text size");
        await expect.poll(fontSize).toBe("14px");
      },
      "Delete page": async () => {
        await run("Delete page");
        await expect(rows.filter({ hasText: "alpha page" })).toHaveCount(0);
      },
      "Find in page": async () => {
        await run("Find in page");
        await expect(app.getByPlaceholder("Find…")).toBeVisible();
        await app.keyboard.press("Escape");
      },
      "Increase text size": async () => {
        await run("Increase text size");
        await expect.poll(fontSize).toBe("16px");
        await run("Reset text size");
      },
      "Keyboard shortcuts": async () => {
        await run("Keyboard shortcuts");
        await expect(app.getByRole("heading", { name: "Keyboard Shortcuts" })).toBeVisible();
        await app.keyboard.press("Escape");
      },
      "New page": async () => {
        await run("New page");
        await expect(app.getByRole("dialog", { name: "Quick add" })).toBeVisible();
        await app.keyboard.press("Escape");
      },
      "Reset text size": async () => {
        await run("Increase text size");
        await run("Reset text size");
        await expect.poll(fontSize).toBe("14px");
      },
      "Select all open pages in folder": async () => {
        await run("Select all open pages in folder");
        await expect(app.locator("[data-page-list-item][data-selected=true]")).toHaveCount(
          await rows.count()
        );
        await app.keyboard.press("Escape");
      },
      "Select next page": async () => {
        const before = await title.textContent();
        await run("Select next page");
        await expect(title).not.toHaveText(before ?? "");
        await run("Select previous page");
        await expect(title).toHaveText(before ?? "");
      },
      "Select previous page": async () => {
        await run("Select next page");
        const after = await title.textContent();
        await run("Select previous page");
        await expect(title).not.toHaveText(after ?? "");
      },
      Settings: async () => {
        await run("Settings");
        await expect(app.getByRole("region", { name: "Settings" })).toBeVisible();
        await app.keyboard.press("Escape");
      },
      "Toggle calendar / editor": async () => {
        await run("Toggle calendar / editor");
        await expect(app.getByRole("region", { name: "Week calendar" })).toBeVisible();
        await run("Toggle calendar / editor");
        await expect(editor).toBeVisible();
      },
      "Toggle completion": async () => {
        await run("Toggle completion");
        await expect(app.getByRole("button", { name: "Mark not done" })).toBeVisible();
        await run("Toggle completion");
        await expect(app.getByRole("button", { name: "Mark done" })).toBeVisible();
      },
      "Toggle sidebar": async () => {
        await run("Toggle sidebar");
        await expect(app.getByRole("button", { name: "Expand sidebar" })).toBeVisible();
        await run("Toggle sidebar");
        await expect(app.getByRole("button", { name: "Collapse sidebar" })).toBeVisible();
      },
      // Runs after "Delete page", which leaves it something to undo.
      "Undo delete": async () => {
        await run("Undo delete");
        await expect(rows.filter({ hasText: "alpha page" })).toHaveCount(1);
      },
    };

    await appTest.step(
      "SRCH-05 Cmd+Shift+K opens the commands while typing in a page",
      async () => {
        await editor.click();
        await app.keyboard.press(mod("Mod+Shift+K"));
        const palette = app.getByRole("dialog", { name: "Search pages" });
        await expect(palette.getByPlaceholder("Search pages, or > for commands…")).toHaveValue(
          /^>/
        );
        await app.keyboard.press("Escape");
        await expect(palette).not.toBeVisible();
      }
    );

    await appTest.step("SRCH-05 > lists exactly the commands with a known effect", async () => {
      const palette = await search(app, ">");
      const listed = (await palette.getByRole("button").allInnerTexts()).map(
        (text) => text.split("\n")[0]!
      );
      await app.keyboard.press("Escape");
      expect([...listed].sort()).toEqual(Object.keys(expectations).sort());
    });

    // Last: "Delete page" takes the open page with it, and "Undo delete" brings it back.
    const last = ["Delete page", "Undo delete"];
    const order = Object.keys(expectations).filter((label) => !last.includes(label));
    for (const label of [...order, ...last]) {
      await appTest.step(`SRCH-05 "${label}" does what it says`, async () => {
        await expectations[label]!();
      });
    }

    await appTest.step("SRCH-05 Cmd+Shift+K with nothing selected opens the list too", async () => {
      await app.locator("body").click({ position: { x: 0, y: 0 } });
      await app.keyboard.press(mod("Mod+Shift+k"));
      await expect(paletteOf(app).getByRole("button", { name: /^New page/ })).toBeVisible();
      await app.keyboard.press("Escape");
    });
  }
);
