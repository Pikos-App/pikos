import { NoopPlatformAdapter } from "@pikos/core";
import type { EditorView } from "@tiptap/pm/view";
import { afterEach, describe, expect, it, vi } from "vitest";

import { subscribeNotices } from "@/shared/events/noticeBus";
import { setPlatform } from "@/shared/platform";

import { insertImageFromDialog } from "./PikosImage";

afterEach(() => setPlatform(null));

function platformWhoseSaveRejects(error: unknown) {
  const platform = new NoopPlatformAdapter();
  vi.spyOn(platform, "pickFile").mockResolvedValue("/Volumes/Photos/cat.png");
  vi.spyOn(platform, "saveAsset").mockRejectedValue(error);
  setPlatform(platform);
}

async function noticeAfterInsert(): Promise<string[]> {
  const seen: string[] = [];
  const off = subscribeNotices((label) => void seen.push(label));
  await insertImageFromDialog({} as EditorView);
  off();
  return seen;
}

describe("a failed image save", () => {
  it("names a full disk as the disk", async () => {
    platformWhoseSaveRejects({ kind: "Io", message: "io: No space left on device" });

    expect(await noticeAfterInsert()).toEqual([
      "Disk error while saving the image. Check available space and permissions.",
    ]);
  });

  it("does not blame the disk for a file it refused", async () => {
    platformWhoseSaveRejects({ kind: "Invalid", message: "extension not allowed" });

    const [notice] = await noticeAfterInsert();

    expect(notice).toMatch(/saving the image/);
    expect(notice).not.toMatch(/disk|space/i);
  });
});
