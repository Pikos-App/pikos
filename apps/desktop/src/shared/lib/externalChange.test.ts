import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { externalChangeSuppressed, markLocalWrite } from "./externalChange";

describe("externalChange suppression", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("is not suppressed before any local write", () => {
    expect(externalChangeSuppressed()).toBe(false);
  });

  it("suppresses immediately after a local write", () => {
    markLocalWrite();
    expect(externalChangeSuppressed()).toBe(true);
  });

  it("stops suppressing once the window elapses", () => {
    markLocalWrite();
    expect(externalChangeSuppressed()).toBe(true);
    vi.advanceTimersByTime(1500); // window boundary
    expect(externalChangeSuppressed()).toBe(false);
  });

  it("a later write re-opens the window", () => {
    markLocalWrite();
    vi.advanceTimersByTime(2000);
    expect(externalChangeSuppressed()).toBe(false);
    markLocalWrite();
    expect(externalChangeSuppressed()).toBe(true);
  });
});
