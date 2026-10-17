import { describe, expect, it, vi } from "vitest";

import { debounce } from "./bridge";
import {
  envelope,
  HOST_TO_WEBVIEW,
  parseHostMessage,
  PROTOCOL_VERSION,
  WEBVIEW_TO_HOST,
} from "./protocol";

describe("message validation", () => {
  it("accepts a well-formed message", () => {
    const result = parseHostMessage({
      payload: { doc: '{"type":"doc"}', pageId: "p1" },
      type: "load",
      v: PROTOCOL_VERSION,
    });
    expect(result.ok).toBe(true);
  });

  it("rejects a message from a different protocol version", () => {
    // The host and the webview are updated independently — an app update can
    // replace the shell while a webview is live — so a version mismatch has to
    // be caught rather than assumed away.
    const result = parseHostMessage({ payload: {}, type: "focus", v: PROTOCOL_VERSION + 1 });
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.error).toContain("protocol version");
  });

  it("rejects an unknown message type", () => {
    const result = parseHostMessage({ payload: {}, type: "selfDestruct", v: PROTOCOL_VERSION });
    expect(result).toMatchObject({ ok: false });
  });

  it("rejects a payload with a missing field", () => {
    const result = parseHostMessage({ payload: { pageId: "p1" }, type: "load", v: PROTOCOL_VERSION });
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.error).toContain("doc");
  });

  it("rejects a payload with a wrong field type", () => {
    const result = parseHostMessage({
      payload: { assetPath: 42 },
      type: "insertImage",
      v: PROTOCOL_VERSION,
    });
    expect(result).toMatchObject({ ok: false });
  });

  it("rejects non-finite numbers", () => {
    // NaN and Infinity serialise to null through JSON, so a number-typed field
    // would arrive as a hole. Rejecting here beats discovering it downstream.
    const result = parseHostMessage({ payload: { px: NaN }, type: "heightChanged", v: PROTOCOL_VERSION });
    expect(result.ok).toBe(false);
  });

  it("rejects a non-integer where an integer is declared", () => {
    // The protocol version is an integer so Swift compares it as an Int rather
    // than a Double. A fractional value would mean the sender and receiver
    // disagree about the type, not just the value.
    const result = parseHostMessage({
      payload: { protocolVersion: 1.5 },
      type: "ready",
      v: PROTOCOL_VERSION,
    });
    expect(result.ok).toBe(false);
  });

  it("rejects non-objects", () => {
    for (const junk of [null, undefined, "string", 42, []]) {
      expect(parseHostMessage(junk).ok).toBe(false);
    }
  });

  it("accepts messages with no fields", () => {
    expect(parseHostMessage({ payload: {}, type: "focus", v: PROTOCOL_VERSION }).ok).toBe(true);
    // A payload key is optional when the message declares no fields.
    expect(parseHostMessage({ type: "blur", v: PROTOCOL_VERSION }).ok).toBe(true);
  });
});

describe("envelopes", () => {
  it("stamps the protocol version", () => {
    expect(envelope("ready", { protocolVersion: PROTOCOL_VERSION })).toEqual({
      payload: { protocolVersion: PROTOCOL_VERSION },
      type: "ready",
      v: PROTOCOL_VERSION,
    });
  });
});

describe("protocol declaration", () => {
  it("documents every message", () => {
    // The declaration is the only description of the bridge that both sides
    // read. An undocumented message is one the other side's author has to guess
    // at, and the Swift generator copies these straight into doc comments.
    for (const spec of [...Object.values(HOST_TO_WEBVIEW), ...Object.values(WEBVIEW_TO_HOST)]) {
      expect(spec.doc.length).toBeGreaterThan(20);
    }
  });

  it("uses distinct names across directions", () => {
    // Overlapping names are legal but make logs ambiguous about which way a
    // message was travelling, which is exactly what you need when debugging a
    // bridge you cannot step through.
    const overlap = Object.keys(HOST_TO_WEBVIEW).filter((k) => k in WEBVIEW_TO_HOST);
    expect(overlap).toEqual([]);
  });
});

describe("debounce", () => {
  it("coalesces bursts into one trailing call", () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const d = debounce(fn, 100);
    d(1);
    d(2);
    d(3);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100);
    expect(fn).toHaveBeenCalledExactlyOnceWith(3);
    vi.useRealTimers();
  });

  it("flushes pending work immediately", () => {
    // Called when the app is backgrounded: iOS may suspend the process shortly
    // after, and a pending debounce would take the last keystrokes with it.
    vi.useFakeTimers();
    const fn = vi.fn();
    const d = debounce(fn, 100);
    d("edit");
    d.flush();
    expect(fn).toHaveBeenCalledExactlyOnceWith("edit");
    vi.advanceTimersByTime(200);
    expect(fn).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("flush is a no-op when nothing is pending", () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    debounce(fn, 100).flush();
    expect(fn).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("cancel drops pending work", () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const d = debounce(fn, 100);
    d("edit");
    d.cancel();
    vi.advanceTimersByTime(200);
    expect(fn).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});
