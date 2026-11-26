// A module accessor rather than a React context, unlike the storage adapter: half the callers are
// plain modules with no provider above them (the Tiptap image extension, the native drop bridge,
// delete-all-data), and threading a platform argument through Tiptap's plugin API would be a
// worse seam than one function call.
//
// Selection happens once, on first use: the no-op adapter under VITE_TEST_MODE, the Tauri
// adapter otherwise.

import type { PlatformAdapter } from "@pikos/core";
import { NoopPlatformAdapter } from "@pikos/core";

import { TauriPlatformAdapter } from "./TauriPlatformAdapter";

let override: PlatformAdapter | null = null;
let fallback: PlatformAdapter | null = null;

export function getPlatform(): PlatformAdapter {
  if (override) return override;
  // Stryker disable next-line ConditionalExpression: neither adapter holds state, so a fresh one per call behaves the same
  if (!fallback) {
    // Stryker disable next-line ConditionalExpression: every test lane builds in test mode; only the packaged app reads false
    if (import.meta.env["VITE_TEST_MODE"] === "true") {
      const noop = new NoopPlatformAdapter();
      (window as unknown as { __PIKOS_PLATFORM_CALLS__?: unknown }).__PIKOS_PLATFORM_CALLS__ =
        noop.calls;
      fallback = noop;
    } else {
      fallback = new TauriPlatformAdapter();
    }
  }
  return fallback;
}

export function setPlatform(next: PlatformAdapter | null): void {
  override = next;
}
