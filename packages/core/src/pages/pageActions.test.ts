import { describe, expect, it } from "vitest";

import { deleteAsksWhichDates, pageActions } from "./pageActions";
import cases from "./pageActions.cases.json";

const plain = { isRecurring: false, scheduledStart: null, scheduleLocked: false };
const dated = { ...plain, scheduledStart: "2026-10-20" };
const series = { ...dated, isRecurring: true };

describe("pageActions", () => {
  it("lists every action in menu order, offered or not", () => {
    expect(pageActions(plain).map((a) => a.id)).toEqual([
      "complete",
      "send-today",
      "send-tomorrow",
      "priority",
      "next-week",
      "pick-date",
      "clear-date",
      "move-to-folder",
      "tags",
      "repeat",
      "stop-repeating",
      "rename",
      "delete",
    ]);
  });

  it("keeps a series and a calendar's page on their own dates", () => {
    for (const page of [series, { ...dated, scheduleLocked: true }]) {
      const sends = pageActions(page).filter((a) =>
        ["send-today", "send-tomorrow", "next-week"].includes(a.id)
      );
      expect(sends.every((a) => !a.offered)).toBe(true);
    }
  });

  it("offers Stop repeating only on a series of your own, one at a time", () => {
    const stop = (page: typeof dated, actsOn = 1) =>
      pageActions(page, actsOn).find((a) => a.id === "stop-repeating");
    expect(stop(series)).toEqual({ id: "stop-repeating", offered: true });
    expect(stop(dated)).toMatchObject({ reason: "not-repeating" });
    expect(stop({ ...series, scheduleLocked: true })).toMatchObject({ reason: "calendar-owned" });
    expect(stop(series, 2)).toMatchObject({ reason: "several-pages" });
  });

  it("completes, tags and sets priority on a calendar's page, which are the user's", () => {
    const offered = pageActions({ ...dated, scheduleLocked: true })
      .filter((a) => a.offered)
      .map((a) => a.id);
    expect(offered).toEqual(["complete", "priority", "tags", "delete"]);
  });

  it("opens a picker on one page only, and on a series of your own", () => {
    const pickers = (page: typeof dated, actsOn = 1) =>
      pageActions(page, actsOn).filter((a) => ["pick-date", "tags", "repeat"].includes(a.id));
    expect(pickers(series).every((a) => a.offered)).toBe(true);
    expect(pickers(dated, 2).every((a) => !a.offered)).toBe(true);
  });

  describe("answers as the phone's menu does", () => {
    for (const c of cases) {
      it(c.name, () => {
        const page = {
          isRecurring: c.page.isRecurring,
          scheduledStart: c.page.hasDate ? "2026-10-20" : null,
          scheduleLocked: c.page.scheduleLocked,
        };
        const answers = Object.fromEntries(
          pageActions(page, c.actsOn)
            .filter((a) => a.id in c.expect)
            .map((a) => [a.id, a.offered ? "offered" : a.reason])
        );
        expect(answers).toEqual(c.expect);
      });
    }
  });
});

describe("deleteAsksWhichDates", () => {
  it("asks on a repeating page of your own", () => {
    expect(deleteAsksWhichDates(series)).toBe(true);
  });

  it("doesn't ask on a plain page", () => {
    expect(deleteAsksWhichDates(dated)).toBe(false);
  });

  it("doesn't ask on a calendar's series, whose dates are upstream's", () => {
    expect(deleteAsksWhichDates({ ...series, scheduleLocked: true })).toBe(false);
  });

  it("doesn't ask when the menu acts on several pages", () => {
    expect(deleteAsksWhichDates(series, 2)).toBe(false);
  });

  it("doesn't ask when the series has no date to skip", () => {
    expect(deleteAsksWhichDates({ ...series, scheduledStart: null })).toBe(false);
  });
});
