import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { cleanTitle, formatSchedule, formatTimeAgo } from "./utils";

describe("cleanTitle", () => {
  it("strips markdown links", () => {
    expect(cleanTitle("[Click here](https://example.com)")).toBe("Click here");
  });

  it("strips bold **text**", () => {
    expect(cleanTitle("**Bold title**")).toBe("Bold title");
  });

  it("strips italic *text*", () => {
    expect(cleanTitle("*Italic title*")).toBe("Italic title");
  });

  it("strips underline bold __text__", () => {
    expect(cleanTitle("__Bold title__")).toBe("Bold title");
  });

  it("strips underline italic _text_", () => {
    expect(cleanTitle("_Italic title_")).toBe("Italic title");
  });

  it("strips nested bold + italic", () => {
    expect(cleanTitle("**_Bold italic_**")).toBe("Bold italic");
  });

  it("handles multiple markdown elements in one title", () => {
    expect(cleanTitle("**Buy** _groceries_ at [Store](http://store.com)")).toBe(
      "Buy groceries at Store"
    );
  });

  it("trims whitespace", () => {
    expect(cleanTitle("  Hello world  ")).toBe("Hello world");
  });

  it("returns empty string for whitespace-only input", () => {
    expect(cleanTitle("   ")).toBe("");
  });

  it("leaves plain text unchanged", () => {
    expect(cleanTitle("Plain title")).toBe("Plain title");
  });

  it("handles empty string", () => {
    expect(cleanTitle("")).toBe("");
  });

  it("strips underscores around words (italic pattern)", () => {
    expect(cleanTitle("_italic_")).toBe("italic");
  });

  it("strips nested markdown in link display text", () => {
    // Link is stripped first → "**Bold link**", then bold is stripped → "Bold link"
    expect(cleanTitle("[**Bold link**](http://example.com)")).toBe("Bold link");
  });
});

describe("formatSchedule", () => {
  it("formats date-only as 'Mon DD'", () => {
    const result = formatSchedule("2025-06-15");
    expect(result).toMatch(/Jun/);
    expect(result).toMatch(/15/);
    expect(result).not.toContain(","); // no time component
  });

  it("formats datetime with time component", () => {
    const result = formatSchedule("2025-06-15T14:30:00");
    expect(result).toMatch(/Jun/);
    expect(result).toMatch(/15/);
    expect(result).toContain(","); // has time separator
  });

  it("returns raw string for unparseable date", () => {
    expect(formatSchedule("not-a-date")).toBe("not-a-date");
  });

  it("handles midnight time (still shows time since T is present)", () => {
    const result = formatSchedule("2025-12-25T00:00:00");
    expect(result).toMatch(/Dec/);
    expect(result).toMatch(/25/);
    expect(result).toContain(","); // datetime includes time
  });
});

describe("formatTimeAgo", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-06-15T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns 'just now' for timestamps less than 1 minute ago", () => {
    const thirtySecondsAgo = new Date("2025-06-15T11:59:40Z").toISOString();
    expect(formatTimeAgo(thirtySecondsAgo)).toBe("just now");
  });

  it("returns minutes for timestamps < 60 minutes ago", () => {
    const fiveMinutesAgo = new Date("2025-06-15T11:55:00Z").toISOString();
    expect(formatTimeAgo(fiveMinutesAgo)).toBe("5m ago");
  });

  it("returns hours for timestamps < 24 hours ago", () => {
    const threeHoursAgo = new Date("2025-06-15T09:00:00Z").toISOString();
    expect(formatTimeAgo(threeHoursAgo)).toBe("3h ago");
  });

  it("returns formatted date for timestamps >= 24 hours ago", () => {
    const twoDaysAgo = new Date("2025-06-13T12:00:00Z").toISOString();
    const result = formatTimeAgo(twoDaysAgo);
    // Should be a date like "Jun 13" — locale-dependent but contains the day number
    expect(result).toMatch(/13/);
  });

  it("returns 'just now' for current timestamp", () => {
    const now = new Date("2025-06-15T12:00:00Z").toISOString();
    expect(formatTimeAgo(now)).toBe("just now");
  });

  it("handles 1 minute exactly", () => {
    const oneMinAgo = new Date("2025-06-15T11:59:00Z").toISOString();
    expect(formatTimeAgo(oneMinAgo)).toBe("1m ago");
  });

  it("handles 59 minutes", () => {
    const fiftyNineMin = new Date("2025-06-15T11:01:00Z").toISOString();
    expect(formatTimeAgo(fiftyNineMin)).toBe("59m ago");
  });

  it("handles exactly 1 hour", () => {
    const oneHour = new Date("2025-06-15T11:00:00Z").toISOString();
    expect(formatTimeAgo(oneHour)).toBe("1h ago");
  });

  it("handles 23 hours", () => {
    const twentyThreeHours = new Date("2025-06-14T13:00:00Z").toISOString();
    expect(formatTimeAgo(twentyThreeHours)).toBe("23h ago");
  });
});
