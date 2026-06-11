import { describe, expect, it, vi } from "vitest";

import { postNotice, subscribeNotices } from "./noticeBus";

describe("noticeBus", () => {
  it("delivers a posted notice to a subscribed handler", () => {
    const handler = vi.fn();
    const unsubscribe = subscribeNotices(handler);

    postNotice("Couldn't save image");

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith("Couldn't save image", undefined);
    unsubscribe();
  });

  it("forwards an explicit durationMs to the handler", () => {
    const handler = vi.fn();
    const unsubscribe = subscribeNotices(handler);

    postNotice("Saved", 1500);

    expect(handler).toHaveBeenCalledWith("Saved", 1500);
    unsubscribe();
  });

  it("stops delivering notices after unsubscribe", () => {
    const handler = vi.fn();
    const unsubscribe = subscribeNotices(handler);
    unsubscribe();

    postNotice("ignored");

    expect(handler).not.toHaveBeenCalled();
  });

  it("delivers to multiple subscribers in order", () => {
    const first = vi.fn();
    const second = vi.fn();
    const unsub1 = subscribeNotices(first);
    const unsub2 = subscribeNotices(second);

    postNotice("hello");

    expect(first).toHaveBeenCalledWith("hello", undefined);
    expect(second).toHaveBeenCalledWith("hello", undefined);
    unsub1();
    unsub2();
  });

  it("drops silently when no subscriber is registered", () => {
    // The image-drop bridge can fire before React mounts; this must not throw.
    expect(() => postNotice("orphan")).not.toThrow();
  });
});
