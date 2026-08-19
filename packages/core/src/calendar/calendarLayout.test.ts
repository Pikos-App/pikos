import { describe, expect, it } from "vitest";

import { makePage } from "./calendar.testHelpers";
import {
  CASCADE_OFFSET_PCT,
  COMPACT_BLOCK_HEIGHT,
  GRID_HEIGHT,
  GRID_START_HOUR,
  HOUR_HEIGHT,
  MAX_VISIBLE_CASCADE_DEPTH,
  OVERFLOW_MIN_WIDTH_PX,
} from "./calendarConstants";
import { buildCollapseGeometry, collapsedBandInnerOffset } from "./calendarGeometry";
import { buildDayBlocks, collapseUnderWidth, remapBlocksForCollapse } from "./calendarLayout";

// ─── collapseUnderWidth ──────────────────────────────────────────────────────

describe("collapseUnderWidth", () => {
  function makeBlock(
    pageId: string,
    leftPct: number,
    widthPct: number,
    top = 0,
    height = 60,
    cascadeDepth = 0
  ): import("./calendarLayout").CalendarBlock {
    return {
      cascadeDepth,
      endDate: new Date(),
      height,
      isCompact: false,
      leftPct,
      page: makePage({ id: pageId }),
      startDate: new Date(),
      top,
      widthPct,
    };
  }

  it("no measurement (columnWidth=0) → unchanged, no pill", () => {
    const blocks = [makeBlock("a", 0, 50), makeBlock("b", 50, 50)];
    const { pill, visible } = collapseUnderWidth(blocks, 0);
    expect(visible).toBe(blocks);
    expect(pill).toBe(null);
  });

  it("all blocks above threshold → no pill", () => {
    // Column width 200, two blocks at 50% each = 100px each (above threshold).
    const blocks = [makeBlock("a", 0, 50), makeBlock("b", 50, 50)];
    const result = collapseUnderWidth(blocks, 200);
    expect(result.visible).toHaveLength(2);
    expect(result.pill).toBe(null);
  });

  it("pill anchors at rightmost collapsed slot, expanded to PILL_MIN_WIDTH_PX", () => {
    // Column 200 → min pill = (64/200)*100 = 32%. Slot is at 86/14 (only
    // 28px wide), expand left so the pill has a readable 32% width and
    // stays right-anchored. Pill is chip-shaped — anchored at slotHost.top.
    const blocks = [
      makeBlock("wide", 0, 60),
      makeBlock("n1", 60, 13, 100),
      makeBlock("n2", 73, 13, 200),
      makeBlock("n3", 86, 14, 150),
    ];
    const { pill, visible } = collapseUnderWidth(blocks, 200);
    expect(visible.map((b) => b.page.id)).toEqual(["wide"]);
    expect(pill?.pageIds).toEqual(["n1", "n2", "n3"]);
    expect(pill?.widthPct).toBe(32);
    expect(pill?.leftPct).toBe(68);
    expect(pill?.top).toBe(150);
  });

  it("pill widthPct caps at 50% on extremely narrow columns", () => {
    // Column 80px → uncapped floor would be 80%. Cap kicks in at 50%.
    const blocks = [makeBlock("a", 0, 30), makeBlock("b", 30, 30), makeBlock("c", 60, 40)];
    const { pill } = collapseUnderWidth(blocks, 80);
    // All three are under the 60px collapse threshold (24, 24, 32 px).
    expect(pill?.widthPct).toBe(50);
    expect(pill?.leftPct).toBe(50);
  });

  it("pill height tracks the chipHeight argument so it scales with density", () => {
    const blocks = [makeBlock("n1", 50, 20, 100, 40), makeBlock("n2", 70, 20, 200, 60)];
    // Compact: hourHeight=40 → compactBlockHeight=10, but the floor kicks in.
    expect(collapseUnderWidth(blocks, 100, 10).pill?.height).toBe(14);
    // Normal: hourHeight=64 → compactBlockHeight=16.
    expect(collapseUnderWidth(blocks, 100, 16).pill?.height).toBe(16);
    // Spacious: hourHeight=88 → compactBlockHeight=22.
    expect(collapseUnderWidth(blocks, 100, 22).pill?.height).toBe(22);
  });

  it("pill height defaults to COMPACT_BLOCK_HEIGHT when no chipHeight is passed", () => {
    const blocks = [makeBlock("n1", 50, 20, 100, 40), makeBlock("n2", 70, 20, 200, 60)];
    expect(collapseUnderWidth(blocks, 100).pill?.height).toBe(COMPACT_BLOCK_HEIGHT);
  });

  it("uses OVERFLOW_MIN_WIDTH_PX as the threshold", () => {
    // Block at exactly threshold passes; one pixel under collapses.
    const ok = makeBlock("ok", 0, OVERFLOW_MIN_WIDTH_PX);
    const bad = makeBlock("bad", 50, OVERFLOW_MIN_WIDTH_PX - 1);
    const { pill, visible } = collapseUnderWidth([ok, bad], 100);
    expect(visible.map((b) => b.page.id)).toEqual(["ok"]);
    expect(pill?.pageIds).toEqual(["bad"]);
  });

  it("conservation: every input block ends up either visible or in the pill", () => {
    // Mixed cluster — wide host, narrow chips of various widthPct/leftPct.
    const blocks = [
      makeBlock("a", 0, 60), // wide → visible
      makeBlock("b", 60, 12, 100), // narrow → collapsed
      makeBlock("c", 72, 14, 200), // narrow → collapsed
      makeBlock("d", 86, 14, 300), // narrow → collapsed
    ];
    const { pill, visible } = collapseUnderWidth(blocks, 200);
    const seen = new Set<string>([...visible.map((b) => b.page.id), ...(pill?.pageIds ?? [])]);
    expect(seen.size).toBe(blocks.length);
    for (const b of blocks) expect(seen.has(b.page.id)).toBe(true);
  });

  it("depth past MAX_VISIBLE_CASCADE_DEPTH collapses even on wide columns", () => {
    // One block per cascade depth, all 90 px wide (well above
    // OVERFLOW_MIN_WIDTH_PX) so width never gates collapse — only depth.
    const blocks = [
      makeBlock("h", 0, 30, 0, 60, 0),
      ...Array.from({ length: MAX_VISIBLE_CASCADE_DEPTH }, (_, i) =>
        makeBlock(`v${i + 1}`, (i + 1) * 12, 30, (i + 1) * 50, 60, i + 1)
      ),
      makeBlock("over1", 60, 30, 400, 60, MAX_VISIBLE_CASCADE_DEPTH + 1),
      makeBlock("over2", 72, 30, 450, 60, MAX_VISIBLE_CASCADE_DEPTH + 2),
    ];
    const { pill, visible } = collapseUnderWidth(blocks, 300);
    const expectedVisible = [
      "h",
      ...Array.from({ length: MAX_VISIBLE_CASCADE_DEPTH }, (_, i) => `v${i + 1}`),
    ];
    expect(visible.map((b) => b.page.id)).toEqual(expectedVisible);
    expect(pill?.pageIds).toEqual(["over1", "over2"]);
  });

  it("depth ≤ MAX_VISIBLE_CASCADE_DEPTH stays visible regardless of column width", () => {
    // Blocks at every depth ≤ MAX in a narrow column. Width would normally
    // collapse them, but the test confirms depth alone doesn't push them out.
    // (Width rule still composes — both rules can fire independently.)
    const blocks = [
      makeBlock("h", 0, 50, 0, 60, 0),
      ...Array.from({ length: MAX_VISIBLE_CASCADE_DEPTH }, (_, i) =>
        makeBlock(`v${i + 1}`, 50, 50, (i + 1) * 50, 60, i + 1)
      ),
    ];
    const { pill, visible } = collapseUnderWidth(blocks, 100);
    expect(visible.length + (pill?.pageIds.length ?? 0)).toBe(blocks.length);
  });
});

// ─── buildDayBlocks ──────────────────────────────────────────────────────────

describe("buildDayBlocks", () => {
  const day = new Date(2026, 2, 15); // March 15

  it("single timed event → full-width, left 0", () => {
    const pages = [
      makePage({
        scheduledEnd: "2026-03-15T10:00:00",
        scheduledStart: "2026-03-15T09:00:00",
        title: "Meeting",
      }),
    ];
    const blocks = buildDayBlocks(pages, day);
    expect(blocks).toHaveLength(1);
    const b = blocks[0]!;
    expect(b.top).toBe((9 - GRID_START_HOUR) * HOUR_HEIGHT);
    expect(b.height).toBe(HOUR_HEIGHT);
    expect(b.leftPct).toBe(0);
    expect(b.widthPct).toBe(100);
    expect(b.isCompact).toBe(false);
  });

  it("synced (locked) timed event renders absolute in the viewer zone; native floats", () => {
    // A native 3pm event floats — positioned at 15:00. A synced 3pm Los_Angeles
    // event is absolute: 15:00 PDT = 22:00 UTC, and the UTC test runner is the
    // viewer zone, so it positions 7h later. The shift is gated on scheduleLocked.
    const native = makePage({
      id: "native",
      scheduledStart: "2026-03-15T15:00:00",
      timezone: "America/Los_Angeles",
      title: "Native 3pm",
    });
    const synced = makePage({
      id: "synced",
      scheduledStart: "2026-03-15T15:00:00",
      scheduleLocked: true,
      timezone: "America/Los_Angeles",
      title: "Synced 3pm PT",
    });
    const blocks = buildDayBlocks([native, synced], day);
    const n = blocks.find((b) => b.page.id === "native")!;
    const s = blocks.find((b) => b.page.id === "synced")!;
    expect(n.top).toBe((15 - GRID_START_HOUR) * HOUR_HEIGHT);
    expect(s.top).toBe((22 - GRID_START_HOUR) * HOUR_HEIGHT);
    expect(s.startDate.getUTCHours()).toBe(22);
  });

  it("all-day synced event never shifts", () => {
    const synced = makePage({
      id: "allday",
      scheduledStart: "2026-03-15",
      scheduleLocked: true,
      timezone: "Asia/Tokyo",
      title: "All-day synced",
    });
    // All-day pages aren't timed blocks — buildDayBlocks excludes them, proving
    // the date-only path is never routed through the zoned conversion.
    expect(buildDayBlocks([synced], day)).toHaveLength(0);
  });

  it("two overlapping events with far tops → cascade (host full width, guest indented)", () => {
    const pages = [
      makePage({
        id: "a",
        scheduledEnd: "2026-03-15T11:00:00",
        scheduledStart: "2026-03-15T09:00:00",
        title: "A",
      }),
      makePage({
        id: "b",
        scheduledEnd: "2026-03-15T11:30:00",
        scheduledStart: "2026-03-15T10:00:00",
        title: "B",
      }),
    ];
    const blocks = buildDayBlocks(pages, day);
    expect(blocks).toHaveLength(2);
    const a = blocks.find((b) => b.page.id === "a")!;
    const b = blocks.find((b) => b.page.id === "b")!;
    expect(a.leftPct).toBe(0);
    expect(a.widthPct).toBe(100);
    expect(b.leftPct).toBe(CASCADE_OFFSET_PCT);
    expect(b.widthPct).toBe(100 - CASCADE_OFFSET_PCT);
  });

  it("two overlapping events with close tops → split 50/50 (would collide cascading)", () => {
    const pages = [
      makePage({
        id: "a",
        scheduledEnd: "2026-03-15T10:00:00",
        scheduledStart: "2026-03-15T09:00:00",
        title: "A",
      }),
      makePage({
        id: "b",
        scheduledEnd: "2026-03-15T10:30:00",
        scheduledStart: "2026-03-15T09:30:00",
        title: "B",
      }),
    ];
    const blocks = buildDayBlocks(pages, day);
    expect(blocks).toHaveLength(2);
    blocks.forEach((b) => expect(b.widthPct).toBe(50));
    const lefts = blocks.map((b) => b.leftPct).sort((x, y) => x - y);
    expect(lefts).toEqual([0, 50]);
  });

  it("three close-top events → host 50%, second guest 50%, third folds via cascadeDepth", () => {
    const pages = [
      makePage({
        id: "a",
        scheduledEnd: "2026-03-15T10:00:00",
        scheduledStart: "2026-03-15T09:00:00",
        title: "A",
      }),
      makePage({
        id: "b",
        scheduledEnd: "2026-03-15T10:00:00",
        scheduledStart: "2026-03-15T09:15:00",
        title: "B",
      }),
      makePage({
        id: "c",
        scheduledEnd: "2026-03-15T10:00:00",
        scheduledStart: "2026-03-15T09:30:00",
        title: "C",
      }),
    ];
    const blocks = buildDayBlocks(pages, day);
    const byId = Object.fromEntries(blocks.map((b) => [b.page.id, b]));
    expect(byId["a"]!.leftPct).toBe(0);
    expect(byId["a"]!.widthPct).toBe(50);
    expect(byId["b"]!.leftPct).toBe(50);
    expect(byId["b"]!.widthPct).toBe(50);
    // c past second slot → marked for the pill, not cascaded inside the 50%.
    expect(byId["c"]!.cascadeDepth).toBeGreaterThan(MAX_VISIBLE_CASCADE_DEPTH);
  });

  it("three overlapping events with spread-out tops → cascade depth 0/1/2", () => {
    const pages = [
      makePage({
        id: "a",
        scheduledEnd: "2026-03-15T13:00:00",
        scheduledStart: "2026-03-15T09:00:00",
        title: "A",
      }),
      makePage({
        id: "b",
        scheduledEnd: "2026-03-15T13:00:00",
        scheduledStart: "2026-03-15T10:15:00",
        title: "B",
      }),
      makePage({
        id: "c",
        scheduledEnd: "2026-03-15T13:00:00",
        scheduledStart: "2026-03-15T11:30:00",
        title: "C",
      }),
    ];
    const blocks = buildDayBlocks(pages, day);
    const a = blocks.find((x) => x.page.id === "a")!;
    const b = blocks.find((x) => x.page.id === "b")!;
    const c = blocks.find((x) => x.page.id === "c")!;
    expect(a.leftPct).toBe(0);
    expect(a.widthPct).toBe(100);
    expect(b.leftPct).toBe(CASCADE_OFFSET_PCT);
    expect(b.widthPct).toBe(100 - CASCADE_OFFSET_PCT);
    expect(c.leftPct).toBe(2 * CASCADE_OFFSET_PCT);
    expect(c.widthPct).toBe(100 - 2 * CASCADE_OFFSET_PCT);
  });

  it("very deep pile of close-top events → host 50%, second 50%, rest fold via cascadeDepth", () => {
    const pages = Array.from({ length: 6 }, (_, i) =>
      makePage({
        id: `p${i}`,
        scheduledEnd: "2026-03-15T11:00:00",
        scheduledStart: `2026-03-15T09:${String(i * 5).padStart(2, "0")}:00`,
        title: `P${i}`,
      })
    );
    const blocks = buildDayBlocks(pages, day);
    const byId = Object.fromEntries(blocks.map((b) => [b.page.id, b]));
    // p0 = host on the left half, depth 0.
    expect(byId["p0"]!.leftPct).toBe(0);
    expect(byId["p0"]!.widthPct).toBe(50);
    expect(byId["p0"]!.cascadeDepth).toBe(0);
    // p1 = next-most-prominent guest on the full right half, depth 1.
    expect(byId["p1"]!.leftPct).toBe(50);
    expect(byId["p1"]!.widthPct).toBe(50);
    expect(byId["p1"]!.cascadeDepth).toBe(1);
    // p2..p5 marked past MAX_VISIBLE_CASCADE_DEPTH so collapseUnderWidth folds
    // them into the pill rather than stacking visual clutter inside the 50%.
    for (let i = 2; i < 6; i++) {
      expect(byId[`p${i}`]!.cascadeDepth).toBeGreaterThan(MAX_VISIBLE_CASCADE_DEPTH);
    }
  });

  it("cascade is capped (depth ≥ 4 events all sit at CASCADE_MAX_LEFT_PCT)", () => {
    // Five events with tops 1h apart. Depths 0..3 cascade; depth 4 lands at
    // the cap — leftPct stops growing so the deepest still has width.
    const pages = Array.from({ length: 5 }, (_, i) =>
      makePage({
        id: `p${i}`,
        scheduledEnd: "2026-03-15T20:00:00",
        scheduledStart: `2026-03-15T${String(9 + i).padStart(2, "0")}:00:00`,
        title: `P${i}`,
      })
    );
    const blocks = buildDayBlocks(pages, day);
    const byId = Object.fromEntries(blocks.map((b) => [b.page.id, b]));
    expect(byId["p0"]!.leftPct).toBe(0);
    expect(byId["p1"]!.leftPct).toBe(CASCADE_OFFSET_PCT);
    expect(byId["p2"]!.leftPct).toBe(2 * CASCADE_OFFSET_PCT);
    expect(byId["p3"]!.leftPct).toBe(3 * CASCADE_OFFSET_PCT);
    // p4 is depth 4 — leftPct caps; widthPct stays at 100 - cap.
    expect(byId["p4"]!.leftPct).toBeLessThanOrEqual(60);
    expect(byId["p4"]!.widthPct).toBeGreaterThanOrEqual(40);
  });

  it("mixed cluster: close-top pair splits, unrelated events still cascade", () => {
    const pages = [
      makePage({
        id: "e0",
        scheduledEnd: "2026-03-15T15:00:00",
        scheduledStart: "2026-03-15T09:00:00",
        title: "E0",
      }),
      makePage({
        id: "e1",
        scheduledEnd: "2026-03-15T15:00:00",
        scheduledStart: "2026-03-15T09:15:00",
        title: "E1",
      }),
      makePage({
        id: "e2",
        scheduledEnd: "2026-03-15T15:00:00",
        scheduledStart: "2026-03-15T11:00:00",
        title: "E2",
      }),
      makePage({
        id: "e3",
        scheduledEnd: "2026-03-15T15:00:00",
        scheduledStart: "2026-03-15T12:30:00",
        title: "E3",
      }),
      makePage({
        id: "e4",
        scheduledEnd: "2026-03-15T15:00:00",
        scheduledStart: "2026-03-15T14:00:00",
        title: "E4",
      }),
    ];
    const byId = Object.fromEntries(buildDayBlocks(pages, day).map((b) => [b.page.id, b]));
    // e0/e1 collide on top → split 50/50.
    expect(byId["e0"]!.widthPct).toBe(50);
    expect(byId["e1"]!.widthPct).toBe(50);
    expect(new Set([byId["e0"]!.leftPct, byId["e1"]!.leftPct])).toEqual(new Set([0, 50]));
    // e2-e4 are spread out → cascade. None should be as narrow as a 5-way split.
    for (const id of ["e2", "e3", "e4"]) {
      expect(byId[id]!.widthPct).toBeGreaterThanOrEqual(100 - 60);
    }
  });

  it("containment (host fully contains guest) → guest cascades on top of host", () => {
    const pages = [
      makePage({
        id: "host",
        scheduledEnd: "2026-03-15T11:00:00",
        scheduledStart: "2026-03-15T09:00:00",
        title: "Host",
      }),
      makePage({
        id: "guest",
        scheduledEnd: "2026-03-15T10:30:00",
        scheduledStart: "2026-03-15T10:00:00",
        title: "Guest",
      }),
    ];
    const blocks = buildDayBlocks(pages, day);
    expect(blocks).toHaveLength(2);
    const host = blocks.find((b) => b.page.id === "host")!;
    const guest = blocks.find((b) => b.page.id === "guest")!;
    expect(host.leftPct).toBe(0);
    expect(host.widthPct).toBe(100);
    expect(guest.leftPct).toBe(CASCADE_OFFSET_PCT);
    expect(guest.widthPct).toBe(100 - CASCADE_OFFSET_PCT);
    // Both keep their own time-accurate top/height.
    expect(host.top).toBe(9 * HOUR_HEIGHT);
    expect(host.height).toBe(2 * HOUR_HEIGHT);
    expect(guest.top).toBe(10 * HOUR_HEIGHT);
    expect(guest.height).toBe(0.5 * HOUR_HEIGHT);
    // DOM order: host (depth 0) before guest (depth 1) so guest paints on top.
    expect(blocks.indexOf(host)).toBeLessThan(blocks.indexOf(guest));
  });

  it("identical range → split (same tops always collide), stable ordering by id", () => {
    const pagesA = [
      makePage({
        id: "aaa",
        scheduledEnd: "2026-03-15T10:00:00",
        scheduledStart: "2026-03-15T09:00:00",
        title: "A",
      }),
      makePage({
        id: "bbb",
        scheduledEnd: "2026-03-15T10:00:00",
        scheduledStart: "2026-03-15T09:00:00",
        title: "B",
      }),
    ];
    const first = buildDayBlocks(pagesA, day);
    const second = buildDayBlocks([...pagesA].reverse(), day);
    const pickIds = (blocks: ReturnType<typeof buildDayBlocks>) =>
      blocks.slice().map((b) => b.page.id);
    expect(pickIds(first)).toEqual(["aaa", "bbb"]);
    expect(pickIds(second)).toEqual(["aaa", "bbb"]);
    first.forEach((b) => expect(b.widthPct).toBe(50));
  });

  it("long host + chips: header-overlapping chip splits 50/50, body chips cascade", () => {
    // Sunday meal prep (12-2 PM) with three reminder chips. The first chip
    // (12:30) lands inside the host's title/time area (32px below host top
    // < CASCADE_MIN_TOP_GAP_PX) so it splits 50/50 with the host. Later chips
    // (1pm, 1:30pm) are well below the header and cascade like normal nested
    // events at sweep-line depth 1.
    const pages = [
      makePage({
        id: "host",
        scheduledEnd: "2026-03-15T14:00:00",
        scheduledStart: "2026-03-15T12:00:00",
        title: "Sunday meal prep",
      }),
      makePage({ id: "c1", scheduledStart: "2026-03-15T12:30:00", title: "Start rice" }),
      makePage({ id: "c2", scheduledStart: "2026-03-15T13:00:00", title: "Preheat oven" }),
      makePage({ id: "c3", scheduledStart: "2026-03-15T13:30:00", title: "Pack lunch" }),
    ];
    const byId = Object.fromEntries(buildDayBlocks(pages, day).map((b) => [b.page.id, b]));
    // Host + first chip collide (chip in host's header) → 50/50 split.
    expect(byId["host"]!.leftPct).toBe(0);
    expect(byId["host"]!.widthPct).toBe(50);
    expect(byId["c1"]!.leftPct).toBe(50);
    expect(byId["c1"]!.widthPct).toBe(50);
    // Other chips don't collide (chip-vs-chip threshold is much tighter, and
    // their gap to the host > CASCADE_MIN_TOP_GAP_PX) → cascade depth 1.
    for (const id of ["c2", "c3"]) {
      expect(byId[id]!.leftPct).toBe(CASCADE_OFFSET_PCT);
      expect(byId[id]!.widthPct).toBe(100 - CASCADE_OFFSET_PCT);
      expect(byId[id]!.isCompact).toBe(true);
    }
  });

  it("non-overlapping earlier event stays full width regardless of later pile", () => {
    const pages = [
      makePage({
        id: "solo",
        scheduledEnd: "2026-03-15T10:00:00",
        scheduledStart: "2026-03-15T09:00:00",
        title: "Solo",
      }),
      makePage({
        id: "p1",
        scheduledEnd: "2026-03-15T12:00:00",
        scheduledStart: "2026-03-15T11:00:00",
        title: "P1",
      }),
      makePage({
        id: "p2",
        scheduledEnd: "2026-03-15T12:00:00",
        scheduledStart: "2026-03-15T11:15:00",
        title: "P2",
      }),
      makePage({
        id: "p3",
        scheduledEnd: "2026-03-15T12:00:00",
        scheduledStart: "2026-03-15T11:30:00",
        title: "P3",
      }),
    ];
    const byId = Object.fromEntries(buildDayBlocks(pages, day).map((b) => [b.page.id, b]));
    // Solo is its own cluster — full width, independent of the later pile.
    expect(byId["solo"]!.leftPct).toBe(0);
    expect(byId["solo"]!.widthPct).toBe(100);
    // The pile has close tops → host 50%, second guest 50%, third folds.
    expect(byId["p1"]!.leftPct).toBe(0);
    expect(byId["p1"]!.widthPct).toBe(50);
    expect(byId["p2"]!.leftPct).toBe(50);
    expect(byId["p2"]!.widthPct).toBe(50);
    expect(byId["p3"]!.cascadeDepth).toBeGreaterThan(MAX_VISIBLE_CASCADE_DEPTH);
  });

  it("third event doesn't fall back to col 0 when col 1 is still alive (cascade visibility)", () => {
    // A 8:30–10:30, B 9:30–12:30, C 11:00–12:00. A ends before C starts so
    // col 0 is technically free, BUT col 1 (B) is still alive at 11:00. C
    // must NOT reuse col 0 — otherwise it'd render at leftPct=0/widthPct=100
    // and B's cascade would cover it (the bug). Force C to a fresh col 2.
    const pages = [
      makePage({
        id: "a",
        scheduledEnd: "2026-03-15T10:30:00",
        scheduledStart: "2026-03-15T08:30:00",
        title: "A",
      }),
      makePage({
        id: "b",
        scheduledEnd: "2026-03-15T12:30:00",
        scheduledStart: "2026-03-15T09:30:00",
        title: "B",
      }),
      makePage({
        id: "c",
        scheduledEnd: "2026-03-15T12:00:00",
        scheduledStart: "2026-03-15T11:00:00",
        title: "C",
      }),
    ];
    const byId = Object.fromEntries(buildDayBlocks(pages, day).map((bb) => [bb.page.id, bb]));
    expect(byId["a"]!.leftPct).toBe(0);
    expect(byId["b"]!.leftPct).toBe(CASCADE_OFFSET_PCT);
    expect(byId["c"]!.leftPct).toBe(2 * CASCADE_OFFSET_PCT);
  });

  it("no-end event → isCompact=true, height=COMPACT_BLOCK_HEIGHT", () => {
    const pages = [makePage({ scheduledStart: "2026-03-15T10:00:00", title: "Quick" })];
    const blocks = buildDayBlocks(pages, day);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.isCompact).toBe(true);
    expect(blocks[0]!.height).toBe(COMPACT_BLOCK_HEIGHT);
  });

  it("sub-15-min event → isCompact=true", () => {
    const pages = [
      makePage({
        scheduledEnd: "2026-03-15T10:10:00",
        scheduledStart: "2026-03-15T10:00:00",
        title: "Brief",
      }),
    ];
    const blocks = buildDayBlocks(pages, day);
    expect(blocks[0]!.isCompact).toBe(true);
    expect(blocks[0]!.height).toBe(COMPACT_BLOCK_HEIGHT);
  });

  it("20-min event rounds up to 30-min visual height", () => {
    const pages = [
      makePage({
        scheduledEnd: "2026-03-15T10:20:00",
        scheduledStart: "2026-03-15T10:00:00",
        title: "20m",
      }),
    ];
    const blocks = buildDayBlocks(pages, day);
    expect(blocks[0]!.height).toBe((30 / 60) * HOUR_HEIGHT);
  });

  it("40-min event rounds up to 45-min visual height", () => {
    const pages = [
      makePage({
        scheduledEnd: "2026-03-15T10:40:00",
        scheduledStart: "2026-03-15T10:00:00",
        title: "40m",
      }),
    ];
    const blocks = buildDayBlocks(pages, day);
    expect(blocks[0]!.height).toBe((45 / 60) * HOUR_HEIGHT);
  });

  it("excludes all-day events", () => {
    const pages = [
      makePage({ scheduledStart: "2026-03-15", title: "All-day" }),
      makePage({
        scheduledEnd: "2026-03-15T10:00:00",
        scheduledStart: "2026-03-15T09:00:00",
        title: "Timed",
      }),
    ];
    const blocks = buildDayBlocks(pages, day);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.page.title).toBe("Timed");
  });

  it("multi-day timed event renders as one segment per day (Mon → Thu = 4 segments)", () => {
    // 9 AM Sun → 5 PM Wed: present on Sun, Mon, Tue, Wed columns. Sun gets
    // segment from 9am to grid bottom (continuation after). Mon/Tue are
    // full-grid continuations both ways. Wed runs from grid top to 5pm.
    const pages = [
      makePage({
        id: "trip",
        scheduledEnd: "2026-03-18T17:00:00",
        scheduledStart: "2026-03-15T09:00:00",
        title: "Conference",
      }),
    ];
    const sun = buildDayBlocks(pages, new Date(2026, 2, 15));
    expect(sun).toHaveLength(1);
    expect(sun[0]!.top).toBe(9 * HOUR_HEIGHT);
    expect(sun[0]!.isContinuationAfter).toBe(true);
    expect(sun[0]!.isContinuationBefore).toBeUndefined();

    const mon = buildDayBlocks(pages, new Date(2026, 2, 16));
    expect(mon).toHaveLength(1);
    expect(mon[0]!.top).toBe(0);
    expect(mon[0]!.isContinuationBefore).toBe(true);
    expect(mon[0]!.isContinuationAfter).toBe(true);

    const tue = buildDayBlocks(pages, new Date(2026, 2, 17));
    expect(tue).toHaveLength(1);
    expect(tue[0]!.top).toBe(0);
    expect(tue[0]!.isContinuationBefore).toBe(true);
    expect(tue[0]!.isContinuationAfter).toBe(true);

    const wed = buildDayBlocks(pages, new Date(2026, 2, 18));
    expect(wed).toHaveLength(1);
    expect(wed[0]!.top).toBe(0);
    expect(wed[0]!.height).toBe(17 * HOUR_HEIGHT);
    expect(wed[0]!.isContinuationBefore).toBe(true);
    expect(wed[0]!.isContinuationAfter).toBeUndefined();
  });

  it("multi-day timed event: present on every spanned day, absent on adjacent days", () => {
    // Sun 9 AM → Wed 5 PM. Should appear on Sun/Mon/Tue/Wed, NOT on the
    // day before (Sat) or after (Thu).
    const pages = [
      makePage({
        id: "trip",
        scheduledEnd: "2026-03-18T17:00:00",
        scheduledStart: "2026-03-15T09:00:00",
        title: "Trip",
      }),
    ];
    const sat = buildDayBlocks(pages, new Date(2026, 2, 14));
    const sun = buildDayBlocks(pages, new Date(2026, 2, 15));
    const mon = buildDayBlocks(pages, new Date(2026, 2, 16));
    const tue = buildDayBlocks(pages, new Date(2026, 2, 17));
    const wed = buildDayBlocks(pages, new Date(2026, 2, 18));
    const thu = buildDayBlocks(pages, new Date(2026, 2, 19));
    expect(sat).toHaveLength(0);
    expect(sun).toHaveLength(1);
    expect(mon).toHaveLength(1);
    expect(tue).toHaveLength(1);
    expect(wed).toHaveLength(1);
    expect(thu).toHaveLength(0);
  });

  it("empty input → empty array", () => {
    expect(buildDayBlocks([], day)).toEqual([]);
  });

  it("ignores pages from other days", () => {
    const pages = [
      makePage({
        scheduledEnd: "2026-03-16T10:00:00",
        scheduledStart: "2026-03-16T09:00:00",
        title: "Wrong day",
      }),
    ];
    expect(buildDayBlocks(pages, day)).toHaveLength(0);
  });

  it("ignores pages with no scheduledStart", () => {
    const pages = [makePage({ scheduledStart: null, title: "No schedule" })];
    expect(buildDayBlocks(pages, day)).toHaveLength(0);
  });

  // ── Cross-day events ──────────────────────────────────────────────────────

  it("event spanning midnight shows on both days", () => {
    const pages = [
      makePage({
        scheduledEnd: "2026-03-16T02:00:00",
        scheduledStart: "2026-03-15T22:00:00",
        title: "Late night",
      }),
    ];

    const blocksDay1 = buildDayBlocks(pages, day);
    expect(blocksDay1).toHaveLength(1);
    const b1 = blocksDay1[0]!;
    expect(b1.top).toBe((22 - GRID_START_HOUR) * HOUR_HEIGHT);
    expect(b1.height).toBe(GRID_HEIGHT - b1.top);
    expect(b1.isContinuationAfter).toBe(true);
    expect(b1.isContinuationBefore).toBeUndefined();

    const nextDay = new Date(2026, 2, 16);
    const blocksDay2 = buildDayBlocks(pages, nextDay);
    expect(blocksDay2).toHaveLength(1);
    const b2 = blocksDay2[0]!;
    expect(b2.top).toBe(0);
    expect(b2.isContinuationBefore).toBe(true);
    expect(b2.isContinuationAfter).toBeUndefined();
  });

  it("event ending exactly at midnight clamps to grid end", () => {
    const pages = [
      makePage({
        scheduledEnd: "2026-03-16T00:00:00",
        scheduledStart: "2026-03-15T16:30:00",
        title: "Evening block",
      }),
    ];

    const blocks = buildDayBlocks(pages, day);
    expect(blocks).toHaveLength(1);
    const b = blocks[0]!;
    expect(b.isContinuationAfter).toBe(true);
    expect(b.top).toBe((16.5 - GRID_START_HOUR) * HOUR_HEIGHT);
    expect(b.height).toBe(GRID_HEIGHT - b.top);
  });

  it("one-midnight event renders as split segments on both spanned days", () => {
    // Single midnight crossed → segment A on day 1 runs to bottom of grid;
    // segment B on day 2 runs from top of grid to event end.
    const pages = [
      makePage({
        scheduledEnd: "2026-03-16T02:45:00",
        scheduledStart: "2026-03-15T18:15:00",
        title: "Late evening",
      }),
    ];

    // Day 1 (segment A): start = 18:15, end = bottom of grid.
    const day1 = buildDayBlocks(pages, day);
    expect(day1).toHaveLength(1);
    expect(day1[0]!.isContinuationAfter).toBe(true);
    expect(day1[0]!.isContinuationBefore).toBeUndefined();

    // Day 2 (segment B): start = top, end = 02:45.
    const day2 = buildDayBlocks(pages, new Date(2026, 2, 16));
    expect(day2).toHaveLength(1);
    expect(day2[0]!.isContinuationBefore).toBe(true);
    expect(day2[0]!.isContinuationAfter).toBeUndefined();
    expect(day2[0]!.top).toBe(0);
    expect(day2[0]!.height).toBe(2.75 * HOUR_HEIGHT);
  });

  it("no-end event at the end of a day is never a continuation", () => {
    const pages = [
      makePage({
        scheduledStart: "2026-03-15T23:45:00",
        title: "Point in time",
      }),
    ];
    const blocks = buildDayBlocks(pages, day);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.isContinuationAfter).toBeUndefined();
    expect(blocks[0]!.isCompact).toBe(true);
  });

  it("cross-day event does not appear on unrelated days", () => {
    const pages = [
      makePage({
        scheduledEnd: "2026-03-16T02:00:00",
        scheduledStart: "2026-03-15T22:00:00",
        title: "Late night",
      }),
    ];
    expect(buildDayBlocks(pages, new Date(2026, 2, 17))).toHaveLength(0);
  });

  it("cross-midnight 11pm→1am: split into 1h on day 1, 1h on day 2", () => {
    const pages = [
      makePage({
        id: "late",
        scheduledEnd: "2026-03-16T01:00:00",
        scheduledStart: "2026-03-15T23:00:00",
        title: "Late",
      }),
    ];
    const a = buildDayBlocks(pages, day);
    expect(a).toHaveLength(1);
    expect(a[0]!.isContinuationAfter).toBe(true);
    expect(a[0]!.isContinuationBefore).toBeUndefined();
    expect(a[0]!.top).toBe(23 * HOUR_HEIGHT);
    expect(a[0]!.height).toBe(HOUR_HEIGHT);

    const b = buildDayBlocks(pages, new Date(2026, 2, 16));
    expect(b).toHaveLength(1);
    expect(b[0]!.isContinuationBefore).toBe(true);
    expect(b[0]!.isContinuationAfter).toBeUndefined();
    expect(b[0]!.top).toBe(0);
    expect(b[0]!.height).toBe(HOUR_HEIGHT);
  });

  it("cross-midnight 6pm→6am: 6h on day 1, 6h on day 2", () => {
    const pages = [
      makePage({
        scheduledEnd: "2026-03-16T06:00:00",
        scheduledStart: "2026-03-15T18:00:00",
        title: "Long night",
      }),
    ];
    const a = buildDayBlocks(pages, day);
    expect(a[0]!.top).toBe(18 * HOUR_HEIGHT);
    expect(a[0]!.height).toBe(6 * HOUR_HEIGHT);
    expect(a[0]!.isContinuationAfter).toBe(true);

    const b = buildDayBlocks(pages, new Date(2026, 2, 16));
    expect(b[0]!.top).toBe(0);
    expect(b[0]!.height).toBe(6 * HOUR_HEIGHT);
    expect(b[0]!.isContinuationBefore).toBe(true);
  });

  it("24-hour event (1 midnight): split as 1h on day 1 + 23h on day 2", () => {
    const pages = [
      makePage({
        scheduledEnd: "2026-03-16T23:00:00", // Mon 11pm
        scheduledStart: "2026-03-15T23:00:00", // Sun 11pm
        title: "Day-long",
      }),
    ];
    // Sunday — segment A: 11pm to bottom (1h before midnight).
    const sun = buildDayBlocks(pages, day);
    expect(sun).toHaveLength(1);
    expect(sun[0]!.isContinuationAfter).toBe(true);
    expect(sun[0]!.top).toBe(23 * HOUR_HEIGHT);
    // Monday — segment B: top to 11pm.
    const mon = buildDayBlocks(pages, new Date(2026, 2, 16));
    expect(mon).toHaveLength(1);
    expect(mon[0]!.isContinuationBefore).toBe(true);
    expect(mon[0]!.top).toBe(0);
    expect(mon[0]!.height).toBe(23 * HOUR_HEIGHT);
  });

  it("cross-day event with same-day overlap cascades when tops are far apart", () => {
    // Overnight visually starts at midnight (top=0), Morning at 8am.
    // Top gap >> CASCADE_MIN_TOP_GAP_PX → cascade.
    const pages = [
      makePage({
        scheduledEnd: "2026-03-16T10:00:00",
        scheduledStart: "2026-03-15T22:00:00",
        title: "Overnight",
      }),
      makePage({
        scheduledEnd: "2026-03-16T09:00:00",
        scheduledStart: "2026-03-16T08:00:00",
        title: "Morning",
      }),
    ];
    const nextDay = new Date(2026, 2, 16);
    const blocks = buildDayBlocks(pages, nextDay);
    expect(blocks).toHaveLength(2);
    const overnight = blocks.find((b) => b.page.title === "Overnight")!;
    const morning = blocks.find((b) => b.page.title === "Morning")!;
    expect(overnight.leftPct).toBe(0);
    expect(morning.leftPct).toBe(CASCADE_OFFSET_PCT);
  });

  it("clipping invariant: every block stays inside its column (leftPct + widthPct ≤ 100)", () => {
    // A pathological mix: deep cascade, close-top split, point clusters,
    // and a containment guest. None of these should produce a block whose
    // rendered width extends past the day-column right edge.
    const pages = [
      makePage({
        id: "host",
        scheduledEnd: "2026-03-15T18:00:00",
        scheduledStart: "2026-03-15T09:00:00",
        title: "Host",
      }),
      makePage({
        id: "g1",
        scheduledEnd: "2026-03-15T13:00:00",
        scheduledStart: "2026-03-15T10:00:00",
        title: "G1",
      }),
      makePage({
        id: "g2",
        scheduledEnd: "2026-03-15T13:00:00",
        scheduledStart: "2026-03-15T11:00:00",
        title: "G2",
      }),
      makePage({
        id: "g3",
        scheduledEnd: "2026-03-15T13:00:00",
        scheduledStart: "2026-03-15T12:00:00",
        title: "G3",
      }),
      makePage({ id: "p1", scheduledStart: "2026-03-15T14:00:00", title: "P1" }),
      makePage({ id: "p2", scheduledStart: "2026-03-15T14:00:00", title: "P2" }),
      makePage({ id: "p3", scheduledStart: "2026-03-15T14:00:00", title: "P3" }),
    ];
    const blocks = buildDayBlocks(pages, day);
    for (const b of blocks) {
      expect(b.leftPct).toBeGreaterThanOrEqual(0);
      expect(b.widthPct).toBeGreaterThanOrEqual(0);
      expect(b.leftPct + b.widthPct).toBeLessThanOrEqual(100);
    }
  });
});

describe("remapBlocksForCollapse", () => {
  const config = { bottomCollapsed: true, bottomHour: 22, topCollapsed: true, topHour: 6 };
  const g = buildCollapseGeometry(config, 64);

  function block(top: number, height: number, id: string) {
    return {
      cascadeDepth: 0,
      endDate: new Date(),
      height,
      isCompact: true,
      leftPct: 0,
      page: makePage({ id }),
      startDate: new Date(),
      top,
      widthPct: 100,
    };
  }

  it("blocks fully in top collapsed range → topCollapsedPageIds", () => {
    const r = remapBlocksForCollapse([block(0, 64, "a"), block(64 * 4, 64, "b")], g);
    expect(r.topCollapsedPageIds).toEqual(["a", "b"]);
    expect(r.visible).toHaveLength(0);
  });

  it("blocks fully in bottom collapsed range → bottomCollapsedPageIds", () => {
    const r = remapBlocksForCollapse([block(64 * 22, 64, "x"), block(64 * 23, 64, "y")], g);
    expect(r.bottomCollapsedPageIds).toEqual(["x", "y"]);
    expect(r.visible).toHaveLength(0);
  });

  it("blocks in middle range → remapped via geometry, stay visible", () => {
    const r = remapBlocksForCollapse([block(64 * 9, 64, "m")], g);
    expect(r.visible).toHaveLength(1);
    expect(r.visible[0]!.top).toBe(g.middleStart + (9 - 6) * 64);
    expect(r.visible[0]!.height).toBe(64);
  });
});

describe("remapBlocksForCollapse — boundary cases", () => {
  const config = { bottomCollapsed: true, bottomHour: 22, topCollapsed: true, topHour: 6 };
  const g = buildCollapseGeometry(config, 64);

  function block(top: number, height: number, id: string) {
    return {
      cascadeDepth: 0,
      endDate: new Date(),
      height,
      isCompact: true,
      leftPct: 0,
      page: makePage({ id }),
      startDate: new Date(),
      top,
      widthPct: 100,
    };
  }

  it("block straddling top boundary clamps top to just past the band's pill", () => {
    // event 5am-9am: starts in collapsed top band, ends in middle. The block's
    // visual top sits 1px below the pill's bottom edge so straddling events all
    // emerge from the same y while still rendering slightly into the band.
    const expectedTop = g.topBandHeight - collapsedBandInnerOffset(g.topBandHeight) + 1;
    const r = remapBlocksForCollapse([block(64 * 5, 64 * 4, "boundary")], g);
    expect(r.visible).toHaveLength(1);
    expect(r.topCollapsedPageIds).toEqual([]);
    const v = r.visible[0]!;
    expect(v.top).toBe(expectedTop);
    expect(v.top + v.height).toBeCloseTo(g.middleStart + 3 * 64, 5);
  });

  it("multiple top-straddling blocks share the same visual top", () => {
    // 5:00–8:00, 5:15–6:15, 5:30–6:30, 5:45–6:45 should all start at the same
    // anchor below the pill, not cascade by start-minute within the band.
    const expectedTop = g.topBandHeight - collapsedBandInnerOffset(g.topBandHeight) + 1;
    const r = remapBlocksForCollapse(
      [
        block(64 * 5, 64 * 3, "a"),
        block(64 * 5.25, 64, "b"),
        block(64 * 5.5, 64, "c"),
        block(64 * 5.75, 64, "d"),
      ],
      g
    );
    expect(r.visible).toHaveLength(4);
    for (const v of r.visible) {
      expect(v.top).toBe(expectedTop);
    }
  });

  it("block straddling bottom boundary clamps bottom to just past the band's pill", () => {
    // event 21:00–24:00: starts in middle, ends in collapsed bottom band. The
    // block's visual bottom mirrors the top: 1px above the pill's top edge.
    const expectedBottom = g.middleEnd + collapsedBandInnerOffset(g.bottomBandHeight) - 1;
    const r = remapBlocksForCollapse([block(64 * 21, 64 * 3, "late")], g);
    expect(r.visible).toHaveLength(1);
    expect(r.bottomCollapsedPageIds).toEqual([]);
    const v = r.visible[0]!;
    expect(v.top).toBe(g.middleStart + 15 * 64);
    expect(v.top + v.height).toBe(expectedBottom);
  });

  it("block straddling bottom boundary stays visible", () => {
    const r = remapBlocksForCollapse([block(64 * 21, 64 * 2, "evening")], g);
    expect(r.visible).toHaveLength(1);
    expect(r.bottomCollapsedPageIds).toEqual([]);
    expect(r.visible[0]!.top).toBe(g.middleStart + 15 * 64);
  });

  it("block ending exactly at topHour boundary → top-collapsed", () => {
    const r = remapBlocksForCollapse([block(64 * 4, 64 * 2, "early")], g);
    expect(r.topCollapsedPageIds).toEqual(["early"]);
    expect(r.visible).toHaveLength(0);
  });

  it("block starting exactly at bottomHour → bottom-collapsed", () => {
    const r = remapBlocksForCollapse([block(64 * 22, 64 * 2, "late")], g);
    expect(r.bottomCollapsedPageIds).toEqual(["late"]);
    expect(r.visible).toHaveLength(0);
  });

  it("when no bands collapsed, every block stays visible", () => {
    const noCollapse = buildCollapseGeometry(
      { bottomCollapsed: false, bottomHour: 22, topCollapsed: false, topHour: 6 },
      64
    );
    const r = remapBlocksForCollapse(
      [block(64 * 2, 64, "early"), block(64 * 23, 64, "late")],
      noCollapse
    );
    expect(r.topCollapsedPageIds).toEqual([]);
    expect(r.bottomCollapsedPageIds).toEqual([]);
    expect(r.visible).toHaveLength(2);
  });

  it("multiple blocks in collapsed band aggregate in source order", () => {
    const r = remapBlocksForCollapse(
      [block(0, 32, "first"), block(32, 32, "second"), block(64, 32, "third")],
      g
    );
    expect(r.topCollapsedPageIds).toEqual(["first", "second", "third"]);
  });

  it("tags top-straddling blocks with straddlesTopBand", () => {
    const r = remapBlocksForCollapse([block(64 * 5, 64 * 4, "boundary")], g);
    expect(r.visible[0]!.straddlesTopBand).toBe(true);
    expect(r.visible[0]!.straddlesBottomBand).toBeUndefined();
  });

  it("tags bottom-straddling blocks with straddlesBottomBand", () => {
    const r = remapBlocksForCollapse([block(64 * 21, 64 * 3, "late")], g);
    expect(r.visible[0]!.straddlesBottomBand).toBe(true);
    expect(r.visible[0]!.straddlesTopBand).toBeUndefined();
  });

  it("a 24h continuation segment straddles both bands", () => {
    // Multi-day continuation: top=0, height=24h. Both straddle flags set so
    // top+bottom corners square (matching the existing isContinuation* path).
    const r = remapBlocksForCollapse([block(0, 64 * 24, "all-day-timed")], g);
    expect(r.visible).toHaveLength(1);
    expect(r.visible[0]!.straddlesTopBand).toBe(true);
    expect(r.visible[0]!.straddlesBottomBand).toBe(true);
  });

  it("blocks fully in middle range have no straddle flags", () => {
    const r = remapBlocksForCollapse([block(64 * 9, 64, "middle")], g);
    expect(r.visible[0]!.straddlesTopBand).toBeUndefined();
    expect(r.visible[0]!.straddlesBottomBand).toBeUndefined();
  });
});
