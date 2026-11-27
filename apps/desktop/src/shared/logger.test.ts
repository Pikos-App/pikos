import { StorageError, toStorageError } from "@pikos/core";
import { describe, expect, it, vi } from "vitest";

import { formatError, type Logger, throttled } from "./logger";

describe("formatError", () => {
  it("truncates a long Error message with an ellipsis", () => {
    const big = "x".repeat(1024);
    const out = formatError(new Error(big));
    expect(out.startsWith("Error: ")).toBe(true);
    const message = out.slice("Error: ".length).split("\n")[0]!;
    expect(message.endsWith("…")).toBe(true);
    expect(message.length).toBe(201);
  });

  it("truncates a long stack with an ellipsis", () => {
    const err = new Error("boom");
    err.stack = "Error: boom\n" + "    at Foo (file.ts:1:1)\n".repeat(200);
    const out = formatError(err);
    const stack = out.split("\n").slice(1).join("\n");
    expect(stack.endsWith("…")).toBe(true);
    expect(stack.length).toBe(201);
  });

  it("leaves short messages untouched", () => {
    const err = new Error("short");
    delete err.stack;
    expect(formatError(err)).toBe("Error: short");
  });

  it("scrubs home-dir paths before truncating", () => {
    // Build the fixture path in pieces so the source-audit grep for hardcoded
    // personal paths (/Users/[a-zA-Z]) doesn't flag the test file itself.
    const homePrefix = "/Users" + "/alice";
    const err = new Error(`failed at ${homePrefix}/secret/${"y".repeat(400)}`);
    const out = formatError(err);
    expect(out).not.toContain(homePrefix);
    expect(out).toContain("~");
  });

  it("truncates long string inputs", () => {
    const out = formatError("z".repeat(1024));
    expect(out.endsWith("…")).toBe(true);
    expect(out.length).toBe(201);
  });

  it("truncates serialised non-Error objects", () => {
    const obj = { blob: "q".repeat(1024) };
    const out = formatError(obj);
    expect(out.endsWith("…")).toBe(true);
    expect(out.length).toBe(201);
  });
});

describe("formatError on errors from the backend", () => {
  const LEAKY = "db error: UNIQUE constraint failed: pages.title = 'My diary'";

  it("prints a StorageError's kind and command, and none of its message", () => {
    const out = formatError(toStorageError({ kind: "Db", message: LEAKY }, "update_page"));

    expect(out).toBe("StorageError(Db) from update_page");
  });

  it("prints a StorageError with no command as its kind", () => {
    expect(formatError(new StorageError("Io", LEAKY))).toBe("StorageError(Io)");
  });

  it("prints the raw { kind, message } a command rejects with as its kind alone", () => {
    expect(formatError({ kind: "Conflict", message: LEAKY })).toBe("AppError(Conflict)");
  });

  it("follows a JS cause under a StorageError", () => {
    const cause = new TypeError("x is undefined");
    delete cause.stack;

    expect(formatError(toStorageError(cause))).toBe(
      "StorageError(Unknown)\ncaused by: TypeError: x is undefined"
    );
  });

  it("follows an Error's cause", () => {
    const inner = toStorageError({ kind: "Network", message: LEAKY }, "resync_sync_account");
    const outer = new Error("resync failed");
    delete outer.stack;
    Object.assign(outer, { cause: inner });

    expect(formatError(outer)).toBe(
      "Error: resync failed\ncaused by: StorageError(Network) from resync_sync_account"
    );
  });

  it("stops following a cause that loops", () => {
    const err = new Error("loop");
    delete err.stack;
    Object.assign(err, { cause: err });

    expect(formatError(err).split("caused by").length).toBe(4);
  });
});

describe("formatError scrubbing", () => {
  it("replaces a URL and an email address, and keeps the webview's own frames", () => {
    const err = new Error(
      "error sending request for url (https://caldav.example.com/dav/me) as me@example.com"
    );
    err.stack = "fetch@tauri://localhost/assets/index.js:1:20";

    const out = formatError(err);

    expect(out).not.toContain("caldav.example.com");
    expect(out).not.toContain("me@example.com");
    expect(out).toContain("<url>");
    expect(out).toContain("<email>");
    expect(out).toContain("fetch@tauri://localhost/assets/index.js:1:20");
  });
});

describe("throttled", () => {
  function spyLogger() {
    const warn = vi.fn<(msg: string, err?: unknown) => void>();
    const log: Logger = { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn };
    return { log, warn };
  }

  it("writes a repeated line once per window and says how many it held back", () => {
    vi.useFakeTimers();
    const { log, warn } = spyLogger();
    const quiet = throttled(log, 1000);

    quiet.warn("list_view failed (Db)");
    quiet.warn("list_view failed (Db)");
    quiet.warn("list_view failed (Db)");
    quiet.warn("count_views failed (Db)");
    vi.advanceTimersByTime(1000);
    quiet.warn("list_view failed (Db)");
    vi.useRealTimers();

    expect(warn.mock.calls.map(([msg]) => msg)).toEqual([
      "list_view failed (Db)",
      "count_views failed (Db)",
      "list_view failed (Db) (and 2 more since the last line)",
    ]);
  });
});
