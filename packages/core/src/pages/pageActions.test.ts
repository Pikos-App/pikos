import { describe, expect, it } from "vitest";

import { deleteAsksWhichDates, pageActions } from "./pageActions";
import cases from "./pageActions.cases.json";

const plain = { isRecurring: false, scheduledStart: null, scheduleLocked: false };
const dated = { ...plain, scheduledStart: "2026-10-20" };
const series = { ...dated, isRecurring: true };

describe("pageActions", () => {
  it("lists every action in menu order, offered or not", () => {
    expect(pageActions(plain).map((a) => a.id)).toEqual([
      "rename",
      "move-to-folder",
      "clear-date",
      "delete",
    ]);
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
          pageActions(page, c.actsOn).map((a) => [a.id, a.offered ? "offered" : a.reason])
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
