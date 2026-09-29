/** True when running inside a Tauri shell (not in test/browser-only mode). */
export const IS_TAURI = import.meta.env["VITE_TEST_MODE"] !== "true";

/** True on macOS (for platform-specific UI like traffic lights). */
export const IS_MACOS = /Mac/.test(navigator.platform);

/** Display label for the platform mod key, used inside inline kbd hints
 *  (e.g. "⌘N" on Mac, "Ctrl+N" elsewhere). */
export const MOD_KEY_LABEL = IS_MACOS ? "⌘" : "Ctrl+";

/** Spoken name for the same key, for text only a screen reader reads. The
 *  glyph above is for the eye: screen readers differ on whether "⌘" is
 *  announced as "command" or skipped outright. */
export const MOD_KEY_SPOKEN = IS_MACOS ? "Command" : "Control";

/** True on Linux. WebKit2GTK's prefers-color-scheme query is unreliable, so
 *  the "system" theme option is hidden — Linux users pick dark or light. */
export const IS_LINUX = /Linux/.test(navigator.platform) && !/Android/.test(navigator.userAgent);
