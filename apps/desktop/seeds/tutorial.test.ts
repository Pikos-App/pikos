import { getLocalTimezone, MockStorageAdapter } from "@pikos/core";
import { describe, expect, it } from "vitest";

import { seedTutorial } from "./tutorial";

describe("seedTutorial", () => {
  it("creates the Start here folder with 3 pages", async () => {
    const adapter = new MockStorageAdapter();
    const result = await seedTutorial(adapter);

    expect(result).not.toBeNull();
    const { folderId, welcomePageId } = result!;

    const folders = await adapter.listFolders();
    expect(folders).toHaveLength(1);
    expect(folders[0]!.name).toBe("Start here");
    expect(folders[0]!.id).toBe(folderId);

    const pages = await adapter.listPages();
    expect(pages).toHaveLength(3);
    expect(pages.every((p) => p.folderId === folderId)).toBe(true);

    const welcomePage = pages.find((p) => p.id === welcomePageId);
    expect(welcomePage).toBeDefined();
    expect(welcomePage!.title).toMatch(/Welcome to Pikos/);
  });

  it("creates page schedules for the welcome and how-it-works pages", async () => {
    const adapter = new MockStorageAdapter();
    await seedTutorial(adapter);

    const pages = await adapter.listPages();
    const welcomePage = pages.find((p) => p.title.startsWith("Welcome to Pikos"))!;
    const howPage = pages.find((p) => p.title === "How it works")!;

    const welcomeSchedules = await adapter.listPageSchedules(welcomePage.id);
    expect(welcomeSchedules).toHaveLength(1);

    const howSchedules = await adapter.listPageSchedules(howPage.id);
    expect(howSchedules).toHaveLength(1);
  });

  it("uses the local timezone for schedules", async () => {
    const adapter = new MockStorageAdapter();
    await seedTutorial(adapter);

    const localTz = getLocalTimezone();
    const pages = await adapter.listPages();
    const welcomePage = pages.find((p) => p.title.startsWith("Welcome to Pikos"))!;
    const [schedule] = await adapter.listPageSchedules(welcomePage.id);

    expect(schedule!.timezone).toBe(localTz);
  });

  it("is idempotent — returns null on second call", async () => {
    const adapter = new MockStorageAdapter();
    const first = await seedTutorial(adapter);
    expect(first).not.toBeNull();

    const second = await seedTutorial(adapter);
    expect(second).toBeNull();

    const pages = await adapter.listPages();
    expect(pages).toHaveLength(3);
  });
});
