import { describe, expect, it } from "vitest";

import { importLinkResolver } from "./links";

describe("importLinkResolver", () => {
  it("prefers an imported page over a workspace page of the same title", () => {
    const resolve = importLinkResolver(
      [{ id: "imported", title: "Plans" }],
      [{ id: "existing", title: "plans" }]
    );

    expect(resolve("PLANS")).toBe("imported");
  });

  it("links nothing for a title two imported pages share, even if the workspace has it once", () => {
    const resolve = importLinkResolver(
      [
        { id: "a", title: "Notes" },
        { id: "b", title: "Notes" },
      ],
      [{ id: "existing", title: "Notes" }]
    );

    expect(resolve("Notes")).toBeNull();
  });
});
