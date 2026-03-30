import { MockStorageAdapter } from "@pikos/core";
import { describe, expect, it } from "vitest";

import { seedTutorial } from "./tutorial";

describe("seedTutorial", () => {
  it("creates Tutorial folder with 4 pages", async () => {
    const adapter = new MockStorageAdapter();
    const result = await seedTutorial(adapter);

    expect(result).not.toBeNull();
    const { folderId, welcomePageId } = result!;

    // Single Tutorial folder created
    const folders = await adapter.listFolders();
    expect(folders).toHaveLength(1);
    expect(folders[0]!.name).toBe("Tutorial");
    expect(folders[0]!.id).toBe(folderId);

    // 4 pages total, all in Tutorial folder
    const pages = await adapter.listPages();
    expect(pages).toHaveLength(4);
    expect(pages.every((p) => p.folderId === folderId)).toBe(true);

    // Welcome page ID matches
    const welcomePage = pages.find((p) => p.id === welcomePageId);
    expect(welcomePage).toBeDefined();
    expect(welcomePage!.title).toMatch(/Welcome to Pikos/);
  });

  it("creates page schedules for workflow and example pages", async () => {
    const adapter = new MockStorageAdapter();
    await seedTutorial(adapter);

    const pages = await adapter.listPages();
    const workflowPage = pages.find((p) => p.title === "Quick add, schedule, complete")!;
    const examplePage = pages.find((p) => p.title === "Example: weekly planning")!;

    const workflowSchedules = await adapter.listPageSchedules(workflowPage.id);
    expect(workflowSchedules).toHaveLength(1);

    const exampleSchedules = await adapter.listPageSchedules(examplePage.id);
    expect(exampleSchedules).toHaveLength(1);
  });

  it("is idempotent — returns null on second call", async () => {
    const adapter = new MockStorageAdapter();
    const first = await seedTutorial(adapter);
    expect(first).not.toBeNull();

    const second = await seedTutorial(adapter);
    expect(second).toBeNull();

    // No duplicate pages
    const pages = await adapter.listPages();
    expect(pages).toHaveLength(4);
  });
});
