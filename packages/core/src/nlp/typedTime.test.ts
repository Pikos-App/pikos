import { describe, expect, it } from "vitest";

import { readTypedTime } from "./typedTime";

describe("readTypedTime", () => {
  it("reads a clock time to the minute", () => {
    expect(readTypedTime("9:05")).toEqual({ hour24: 9, minute: 5 });
  });

  it("reads a time with a length", () => {
    expect(readTypedTime("3pm for 45m")).toEqual({ durationMinutes: 45, hour24: 15, minute: 0 });
  });

  it("reads a range as a time and a length", () => {
    expect(readTypedTime("3pm to 5pm")).toEqual({ durationMinutes: 120, hour24: 15, minute: 0 });
  });

  it("refuses a date with no time", () => {
    expect(readTypedTime("tomorrow")).toBeNull();
  });

  it("refuses input with words it can't read", () => {
    expect(readTypedTime("3pm dentist")).toBeNull();
  });

  it("refuses nothing typed", () => {
    expect(readTypedTime("  ")).toBeNull();
  });
});
