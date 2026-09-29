import { afterEach, describe, expect, it, vi } from "vitest";

import { flushPendingWrites, onDrainPending, onFlushPending } from "./pendingWrites";

// Draining has to be two phases. A producer (the editor's autosave) hands its
// content to the write queue, and the queue is the drain — so a single-phase
// flush writes the queue out while the editor is still holding the newest text.
describe("pendingWrites", () => {
  // The registries are module-level, so a test that leaves one registered is seen
  // by the next. Disposers run in afterEach whatever the outcome.
  let disposers: (() => void)[] = [];

  function track(off: () => void): void {
    disposers.push(off);
  }

  afterEach(() => {
    for (const off of disposers) off();
    disposers = [];
    vi.restoreAllMocks();
  });

  it("runs every producer before any drain", async () => {
    const order: string[] = [];
    track(onFlushPending(() => void order.push("producer-a")));
    track(onDrainPending(() => void order.push("drain")));
    track(onFlushPending(() => void order.push("producer-b")));

    await flushPendingWrites();

    expect(order).toHaveLength(3);
    expect(order.indexOf("drain")).toBeGreaterThan(order.indexOf("producer-a"));
    expect(order.indexOf("drain")).toBeGreaterThan(order.indexOf("producer-b"));
  });

  it("waits for an async producer to settle before draining", async () => {
    const order: string[] = [];
    track(
      onFlushPending(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        order.push("producer");
      })
    );
    track(onDrainPending(() => void order.push("drain")));

    await flushPendingWrites();

    expect(order).toEqual(["producer", "drain"]);
  });

  it("still drains when a producer throws synchronously", async () => {
    const drain = vi.fn();
    track(
      onFlushPending(() => {
        throw new Error("editor is wedged");
      })
    );
    track(onDrainPending(drain));

    await expect(flushPendingWrites()).resolves.toBeUndefined();

    expect(drain).toHaveBeenCalled();
  });

  it("still drains when a producer rejects", async () => {
    const drain = vi.fn();
    track(onFlushPending(() => Promise.reject(new Error("write failed"))));
    track(onDrainPending(drain));

    await expect(flushPendingWrites()).resolves.toBeUndefined();

    expect(drain).toHaveBeenCalled();
  });

  it("stops calling a flusher once it unregisters", async () => {
    const fn = vi.fn();
    const off = onFlushPending(fn);
    off();

    await flushPendingWrites();

    expect(fn).not.toHaveBeenCalled();
  });
});
