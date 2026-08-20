import { MockStorageAdapter } from "@pikos/core/testing";
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { subscribeNotices } from "@/shared/events/noticeBus";

import { formatElapsed, MIN_SESSION_S, useFocusTimer } from "./useFocusTimer";

vi.stubEnv("VITE_TEST_MODE", "true");

let adapter: MockStorageAdapter;
let pageId: string;

beforeEach(async () => {
  vi.useFakeTimers();
  adapter = new MockStorageAdapter();
  // The writer refuses a session against a page that doesn't exist, so the
  // fixture needs the real row rather than just its id.
  const page = await adapter.createPage({
    content: "",
    folderId: null,
    priority: 0,
    status: "not_started",
    tags: [],
    title: "Deep work",
  });
  pageId = page.id;
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function setup() {
  return renderHook(() => useFocusTimer(adapter, pageId));
}

/** Advance both the interval and the wall clock the hook reads, since elapsed is
 *  computed from `Date.now()` rather than counted in ticks. */
async function advance(seconds: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(seconds * 1000);
  });
}

describe("useFocusTimer", () => {
  it("starts idle", () => {
    const { result } = setup();
    expect(result.current.running).toBe(false);
    expect(result.current.elapsedS).toBe(0);
  });

  it("ticks once a second while running", async () => {
    const { result } = setup();
    act(() => result.current.start());
    expect(result.current.running).toBe(true);

    await advance(1);
    expect(result.current.elapsedS).toBe(1);
    await advance(4);
    expect(result.current.elapsedS).toBe(5);
  });

  it("writes the session on stop and returns to idle", async () => {
    const { result } = setup();
    act(() => result.current.start());
    await advance(90);

    await act(async () => {
      await result.current.stop();
    });

    const sessions = adapter.listFocusSessionsForTest();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.pageId).toBe(pageId);
    expect(sessions[0]!.durationS).toBe(90);
    expect(result.current.running).toBe(false);
    expect(result.current.elapsedS).toBe(0);
  });

  it("discards a session shorter than the floor", async () => {
    const { result } = setup();
    act(() => result.current.start());
    await advance(MIN_SESSION_S - 1);

    await act(async () => {
      await result.current.stop();
    });

    expect(adapter.listFocusSessionsForTest()).toEqual([]);
    expect(result.current.running).toBe(false);
  });

  it("records a session exactly at the floor", async () => {
    const { result } = setup();
    act(() => result.current.start());
    await advance(MIN_SESSION_S);

    await act(async () => {
      await result.current.stop();
    });

    expect(adapter.listFocusSessionsForTest()).toHaveLength(1);
  });

  it("stopping when nothing is running writes nothing", async () => {
    const { result } = setup();
    await act(async () => {
      await result.current.stop();
    });
    expect(adapter.listFocusSessionsForTest()).toEqual([]);
  });

  it("banks a running session when the page unmounts", async () => {
    const { result, unmount } = setup();
    act(() => result.current.start());
    await advance(120);

    await act(async () => {
      unmount();
      await Promise.resolve();
    });

    const sessions = adapter.listFocusSessionsForTest();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.durationS).toBe(120);
  });

  it("unmounting while idle writes nothing", async () => {
    const { unmount } = setup();
    await act(async () => {
      unmount();
      await Promise.resolve();
    });
    expect(adapter.listFocusSessionsForTest()).toEqual([]);
  });

  it("a rejected write is swallowed rather than surfaced", async () => {
    vi.spyOn(adapter, "createFocusSession").mockRejectedValue(new Error("db gone"));
    const { result } = setup();
    act(() => result.current.start());
    await advance(60);

    await act(async () => {
      await expect(result.current.stop()).resolves.toBeUndefined();
    });
    expect(result.current.running).toBe(false);
  });

  it("does nothing without a storage adapter", async () => {
    const { result } = renderHook(() => useFocusTimer(null, pageId));
    act(() => result.current.start());
    await advance(60);
    await act(async () => {
      await result.current.stop();
    });
    expect(adapter.listFocusSessionsForTest()).toEqual([]);
  });
});

describe("formatElapsed", () => {
  it.each([
    [0, "0:00"],
    [5, "0:05"],
    [59, "0:59"],
    [60, "1:00"],
    [95, "1:35"],
    [599, "9:59"],
    [3599, "59:59"],
    [3600, "1:00:00"],
    [3661, "1:01:01"],
    [36061, "10:01:01"],
  ])("%i seconds → %s", (seconds, expected) => {
    expect(formatElapsed(seconds)).toBe(expected);
  });

  it("clamps a negative input rather than rendering a minus sign", () => {
    expect(formatElapsed(-5)).toBe("0:00");
  });
});

describe("end-of-session notice", () => {
  let notices: string[];
  let unsubscribe: () => void;

  beforeEach(() => {
    notices = [];
    unsubscribe = subscribeNotices((label) => notices.push(label));
  });

  afterEach(() => unsubscribe());

  async function runSession(seconds: number) {
    const { result } = setup();
    act(() => result.current.start());
    await advance(seconds);
    await act(async () => {
      await result.current.stop();
    });
  }

  it("reports a recorded session in whole minutes", async () => {
    await runSession(25 * 60);
    expect(notices).toEqual(["Focused for 25 minutes"]);
  });

  it("says so when a session was too short to record", async () => {
    await runSession(MIN_SESSION_S - 1);
    expect(notices).toEqual([`Under ${MIN_SESSION_S} seconds — not recorded`]);
  });

  it("carries the hour once a session passes one", async () => {
    await runSession(95 * 60);
    expect(notices).toEqual(["Focused for 1 hour 35 min"]);
  });
});
