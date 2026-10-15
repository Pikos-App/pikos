import type { StorageAdapter } from "@pikos/core";
import { MockStorageAdapter } from "@pikos/core/testing";
import { describe, expect, it } from "vitest";

import { seedCalendar } from "./calendar";
import { DEEP_SCALE, seedDeep } from "./deep";
import { seedEditor } from "./editor";
import { seedWide } from "./wide";

const smallDeep = (adapter: StorageAdapter) =>
  seedDeep(adapter, {
    ...DEEP_SCALE,
    focusSessions: 10,
    hugeDocuments: 1,
    pages: 80,
    seriesHistory: 0.1,
    subpageParents: 3,
    trashed: 3,
  });

describe.each<[string, (adapter: StorageAdapter) => Promise<void>]>([
  ["calendar", seedCalendar],
  ["deep", smallDeep],
  ["editor", seedEditor],
  ["wide", seedWide],
])("%s seed", (_name, seed) => {
  it("adds nothing when planted into a workspace that already has it", async () => {
    const adapter = new MockStorageAdapter();
    await seed(adapter);
    const planted = (await adapter.listPages()).length;
    expect(planted).toBeGreaterThan(0);

    await seed(adapter);

    expect(await adapter.listPages()).toHaveLength(planted);
  });
});
