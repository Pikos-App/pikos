// Synced events own a locked schedule (scheduleLocked). The resize gesture must
// no-op on a locked block — handleBlockResizeStart returns before attaching any
// listeners, so onReschedule never fires. Mirrored with an unlocked block to
// prove the guard, not a dead harness.

import type { CalendarBlock, PageSummary } from "@pikos/core";
import { buildCollapseGeometry, DEFAULT_COLLAPSE_CONFIG, DEFAULT_METRICS } from "@pikos/core";
import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { useTimedResize } from "./useTimedResize";

function makePage(scheduleLocked: boolean): PageSummary {
  return {
    createdAt: "2026-01-01T00:00:00",
    folderId: null,
    id: "p1",
    isRecurring: false,
    priority: 0,
    scheduledEnd: "2099-01-05T10:00:00",
    scheduledStart: "2099-01-05T09:00:00",
    scheduleLocked,
    sortOrder: 0,
    status: "not_started",
    tags: [],
    title: "Standup",
    updatedAt: "2026-01-01T00:00:00",
  };
}

function makeBlock(page: PageSummary): CalendarBlock {
  return {
    cascadeDepth: 0,
    endDate: new Date("2099-01-05T10:00:00"),
    height: 64,
    isCompact: false,
    leftPct: 0,
    page,
    startDate: new Date("2099-01-05T09:00:00"),
    top: 100,
    widthPct: 100,
  };
}

function setup(scheduleLocked: boolean) {
  const onReschedule = vi.fn();
  const scrollEl = document.createElement("div");
  const scrollRef = { current: scrollEl };
  const geometry = buildCollapseGeometry(DEFAULT_COLLAPSE_CONFIG, DEFAULT_METRICS.hourHeight);

  const { result } = renderHook(() =>
    useTimedResize({
      days: [new Date("2099-01-05T00:00:00")],
      disableSelect: vi.fn(),
      eatNextClick: vi.fn(),
      enableSelect: vi.fn(),
      geometry,
      metrics: DEFAULT_METRICS,
      onReschedule,
      scrollRef,
    })
  );

  const page = makePage(scheduleLocked);
  result.current.handleBlockResizeStart({ block: makeBlock(page), dayIndex: 0, pageId: page.id });

  window.dispatchEvent(new MouseEvent("mousemove", { clientY: 300 }));
  window.dispatchEvent(new MouseEvent("mouseup", { clientY: 300 }));

  return { onReschedule };
}

describe("useTimedResize — schedule lock guard", () => {
  it("does not reschedule a locked (synced) block", () => {
    const { onReschedule } = setup(true);
    expect(onReschedule).not.toHaveBeenCalled();
  });

  it("reschedules an unlocked block", () => {
    const { onReschedule } = setup(false);
    expect(onReschedule).toHaveBeenCalledTimes(1);
  });
});
