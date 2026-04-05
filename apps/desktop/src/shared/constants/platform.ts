// Platform detection constants.

/** True when running inside a Tauri shell (not in test/browser-only mode). */
export const IS_TAURI = import.meta.env["VITE_TEST_MODE"] !== "true";

/** True on macOS (for platform-specific UI like traffic lights). */
export const IS_MACOS = /Mac/.test(navigator.platform);
