import { buildCollapseGeometry, DEFAULT_COLLAPSE_CONFIG, DEFAULT_METRICS } from "@pikos/core";
import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { useDragGhost } from "./useDragGhost";

function setup() {
  const { result } = renderHook(() =>
    useDragGhost({
      dayColumnsRef: { current: document.createElement("div") },
      days: [new Date("2099-01-05T00:00:00"), new Date("2099-01-06T00:00:00")],
      geometry: buildCollapseGeometry(DEFAULT_COLLAPSE_CONFIG, DEFAULT_METRICS.hourHeight),
    })
  );

  return result;
}

describe("useDragGhost", () => {
  it("keeps a ghost mounted with no position hidden until a drag shows it", () => {
    const result = setup();
    const ghost = document.createElement("div");

    result.current.ghostRefCallback(ghost);
    expect(ghost.style.display).toBe("none");

    result.current.positionGhost(1, 120, 20);
    result.current.showGhost();
    expect(ghost.style.display).toBe("");
    expect(ghost.style.top).toBe("120px");
  });

  it("shows a ghost mounted with a queued position at that position", () => {
    const result = setup();
    const ghost = document.createElement("div");

    result.current.queueInitialPosition(0, 60, 20);
    result.current.ghostRefCallback(ghost);

    expect(ghost.style.display).toBe("");
    expect(ghost.style.top).toBe("60px");
  });
});
