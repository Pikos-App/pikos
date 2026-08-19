// How the app reaches the host shell.
//
// A module accessor rather than a React context, unlike the storage adapter:
// half the callers are not components. The Tiptap image extension, the native
// drop bridge and the delete-all-data routine are plain modules with no
// provider above them, and threading a platform argument through Tiptap's
// plugin API to reach them would be a worse seam than one function call.
//
// Selection happens once, on first use: the no-op adapter under VITE_TEST_MODE
// (unit tests and the e2e browser build, neither of which has a Tauri shell),
// the Tauri adapter otherwise. `setPlatform` lets a test swap in its own
// double; pass `null` to fall back to the default again.

import type { PlatformAdapter } from "@pikos/core";
import { NoopPlatformAdapter } from "@pikos/core";

import { TauriPlatformAdapter } from "./TauriPlatformAdapter";

let override: PlatformAdapter | null = null;
let fallback: PlatformAdapter | null = null;

export function getPlatform(): PlatformAdapter {
  if (override) return override;
  fallback ??=
    import.meta.env["VITE_TEST_MODE"] === "true"
      ? new NoopPlatformAdapter()
      : new TauriPlatformAdapter();
  return fallback;
}

/** Test seam. Pass null to restore the environment default. */
export function setPlatform(next: PlatformAdapter | null): void {
  override = next;
}
