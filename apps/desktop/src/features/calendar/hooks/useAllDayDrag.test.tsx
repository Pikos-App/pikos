// Synced events own a locked schedule (scheduleLocked). Both all-day gestures —
// the chip drag and the left/right edge resize — must no-op on a locked block:
// each handler returns before attaching listeners, so onReschedule never fires.
// Mirrored with unlocked blocks to prove the guards, not a dead harness.

import type { PageSummary } from "@pikos/core";
import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { DEFAULT_COLLAPSE_CONFIG } from "../utils/calendarConstants";
import { buildCollapseGeometry, DEFAULT_METRICS } from "../utils/calendarGeometry";
import { useAllDayDrag } from "./useAllDayDrag";

function makePage(scheduleLocked: boolean): PageSummary {
  return {
    createdAt: "2026-01-01T00:00:00",
    folderId: null,
    id: "p1",
    isRecurring: false,
    priority: 0,
    scheduledEnd: "2099-01-06",
    scheduledStart: "2099-01-05",
    scheduleLocked,
    sortOrder: 0,
    status: "not_started",
    tags: [],
    title: "Trip",
    updatedAt: "2026-01-01T00:00:00",
  };
}

function setup(scheduleLocked: boolean) {
  const onReschedule = vi.fn();
  const scrollRef = { current: document.createElement("div") };
  const dayColumnsRef = { current: document.createElement("div") };
  const geometry = buildCollapseGeometry(DEFAULT_COLLAPSE_CONFIG, DEFAULT_METRICS.hourHeight);

  const { result } = renderHook(() =>
    useAllDayDrag({
      dayColumnsRef,
      days: [new Date("2099-01-05T00:00:00"), new Date("2099-01-06T00:00:00")],
      disableSelect: vi.fn(),
      eatNextClick: vi.fn(),
      enableSelect: vi.fn(),
      geometry,
      hideGhost: vi.fn(),
      metrics: DEFAULT_METRICS,
      onReschedule,
      pages: [makePage(scheduleLocked)],
      positionGhost: vi.fn(),
      scrollRef,
      setGhostContent: vi.fn(),
      showGhost: vi.fn(),
    })
  );

  return { onReschedule, result };
}

describe("useAllDayDrag — chip drag schedule lock guard", () => {
  it("does not reschedule a locked (synced) chip", () => {
    const { onReschedule, result } = setup(true);
    result.current.handleAllDayChipDragStart({ folderColor: undefined, pageId: "p1" });
    window.dispatchEvent(new MouseEvent("mousemove", { clientX: 10, clientY: -50 }));
    window.dispatchEvent(new MouseEvent("mouseup", { clientX: 10, clientY: -50 }));
    expect(onReschedule).not.toHaveBeenCalled();
  });

  it("reschedules an unlocked chip dropped on a column", () => {
    const { onReschedule, result } = setup(false);
    result.current.handleAllDayChipDragStart({ folderColor: undefined, pageId: "p1" });
    // Negative clientY keeps the cursor in the all-day strip (rect.top is 0 in jsdom).
    window.dispatchEvent(new MouseEvent("mousemove", { clientX: 10, clientY: -50 }));
    window.dispatchEvent(new MouseEvent("mouseup", { clientX: 10, clientY: -50 }));
    expect(onReschedule).toHaveBeenCalledTimes(1);
  });
});

describe("useAllDayDrag — edge resize schedule lock guard", () => {
  it("does not reschedule a locked (synced) chip on edge resize", () => {
    const { onReschedule, result } = setup(true);
    result.current.handleAllDayEdgeResizeStart({
      clientX: 10,
      clientY: 5,
      edge: "end",
      pageId: "p1",
    });
    window.dispatchEvent(new MouseEvent("mousemove", { clientX: 10, clientY: 5 }));
    window.dispatchEvent(new MouseEvent("mouseup", { clientX: 10, clientY: 5 }));
    expect(onReschedule).not.toHaveBeenCalled();
  });

  it("reschedules an unlocked chip on edge resize", () => {
    const { onReschedule, result } = setup(false);
    result.current.handleAllDayEdgeResizeStart({
      clientX: 10,
      clientY: 5,
      edge: "end",
      pageId: "p1",
    });
    window.dispatchEvent(new MouseEvent("mousemove", { clientX: 10, clientY: 5 }));
    window.dispatchEvent(new MouseEvent("mouseup", { clientX: 10, clientY: 5 }));
    expect(onReschedule).toHaveBeenCalledTimes(1);
  });
});
