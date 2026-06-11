import type { PageStatus } from "@pikos/core";
import { describe, expect, it } from "vitest";

import { partitionToggleSelection } from "./toggleSelection";

const page = (id: string, status: PageStatus) => ({ id, status });

describe("partitionToggleSelection", () => {
  const isRecurring = (id: string) => new Set(["r1", "r2"]).has(id);

  it("completes every not-done non-recurring page (the Cmd+A → Space flow)", () => {
    const groups = partitionToggleSelection(
      [page("a", "not_started"), page("b", "not_started"), page("c", "not_started")],
      () => false
    );
    // All in one bulk group → one transactional write, no per-page race.
    expect(groups.toComplete).toEqual(["a", "b", "c"]);
    expect(groups.toUncomplete).toEqual([]);
    expect(groups.recurring).toEqual([]);
  });

  it("preserves toggle semantics on a mixed selection", () => {
    const groups = partitionToggleSelection(
      [page("a", "done"), page("b", "not_started")],
      () => false
    );
    expect(groups.toComplete).toEqual(["b"]);
    expect(groups.toUncomplete).toEqual(["a"]);
  });

  it("keeps recurring pages out of the bulk groups (they need clone + advance)", () => {
    const groups = partitionToggleSelection(
      [page("r1", "not_started"), page("a", "not_started"), page("r2", "done")],
      isRecurring
    );
    expect(groups.toComplete).toEqual(["a"]);
    expect(groups.toUncomplete).toEqual([]);
    expect(groups.recurring.map((p) => p.id)).toEqual(["r1", "r2"]);
  });
});
