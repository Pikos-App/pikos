// Synced events own a locked schedule (scheduleLocked). The timed-block drag
// must no-op on a locked block — handleBlockDragStart returns before attaching
// any listeners, so onReschedule never fires, including the drop-into-all-day
// branch. Mirrored with an unlocked block to prove the guard, not a dead harness.

import type { CalendarBlock, PageSummary } from "@pikos/core";
import { buildCollapseGeometry, DEFAULT_COLLAPSE_CONFIG, DEFAULT_METRICS } from "@pikos/core";
import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { BlockDragStartInfo } from "../components/DayColumn";
import { useTimedDrag } from "./useTimedDrag";

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
  const scrollRef = { current: document.createElement("div") };
  const dayColumnsRef = { current: document.createElement("div") };
  const geometry = buildCollapseGeometry(DEFAULT_COLLAPSE_CONFIG, DEFAULT_METRICS.hourHeight);

  const { result } = renderHook(() =>
    useTimedDrag({
      dayColumnsRef,
      days: [new Date("2099-01-05T00:00:00")],
      disableSelect: vi.fn(),
      eatNextClick: vi.fn(),
      enableSelect: vi.fn(),
      geometry,
      hideGhost: vi.fn(),
      metrics: DEFAULT_METRICS,
      onReschedule,
      pages: [makePage(scheduleLocked)],
      positionGhost: vi.fn(),
      queueInitialGhostPosition: vi.fn(),
      scrollRef,
      setGhostContent: vi.fn(),
      showGhost: vi.fn(),
    })
  );

  const page = makePage(scheduleLocked);
  const info: BlockDragStartInfo = {
    block: makeBlock(page),
    clientY: 150,
    dayIndex: 0,
    folderColor: undefined,
    pageId: page.id,
  };
  return { info, onReschedule, result };
}

describe("useTimedDrag — schedule lock guard", () => {
  it("does not reschedule a locked (synced) block dropped in the grid", () => {
    const { info, onReschedule, result } = setup(true);
    result.current.handleBlockDragStart(info);
    window.dispatchEvent(
      new PointerEvent("pointermove", { clientX: 10, clientY: 300, isPrimary: true })
    );
    window.dispatchEvent(
      new PointerEvent("pointerup", { clientX: 10, clientY: 300, isPrimary: true })
    );
    expect(onReschedule).not.toHaveBeenCalled();
  });

  it("does not reschedule a locked (synced) block dropped into the all-day strip", () => {
    const { info, onReschedule, result } = setup(true);
    result.current.handleBlockDragStart(info);
    // Negative clientY → above the grid top (rect.top is 0 in jsdom) = all-day drop.
    window.dispatchEvent(
      new PointerEvent("pointermove", { clientX: 10, clientY: -50, isPrimary: true })
    );
    window.dispatchEvent(
      new PointerEvent("pointerup", { clientX: 10, clientY: -50, isPrimary: true })
    );
    expect(onReschedule).not.toHaveBeenCalled();
  });

  it("reschedules an unlocked block dropped in the grid", () => {
    const { info, onReschedule, result } = setup(false);
    result.current.handleBlockDragStart(info);
    window.dispatchEvent(
      new PointerEvent("pointermove", { clientX: 10, clientY: 300, isPrimary: true })
    );
    window.dispatchEvent(
      new PointerEvent("pointerup", { clientX: 10, clientY: 300, isPrimary: true })
    );
    expect(onReschedule).toHaveBeenCalledTimes(1);
  });

  it("reschedules an unlocked block dropped into the all-day strip", () => {
    const { info, onReschedule, result } = setup(false);
    result.current.handleBlockDragStart(info);
    window.dispatchEvent(
      new PointerEvent("pointermove", { clientX: 10, clientY: -50, isPrimary: true })
    );
    window.dispatchEvent(
      new PointerEvent("pointerup", { clientX: 10, clientY: -50, isPrimary: true })
    );
    expect(onReschedule).toHaveBeenCalledTimes(1);
    // All-day drop → date-only start, no end.
    expect(onReschedule).toHaveBeenCalledWith("p1", "2099-01-05", undefined, undefined);
  });
});
