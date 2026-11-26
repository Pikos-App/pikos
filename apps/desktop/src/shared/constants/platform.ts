import { IS_TEST_MODE } from "@/shared/constants/testMode";

export const IS_TAURI = !IS_TEST_MODE;

export const IS_MACOS = /Mac/.test(navigator.platform);

/** Display label for the platform mod key in inline kbd hints ("⌘N" on Mac, "Ctrl+N" elsewhere). */
export const MOD_KEY_LABEL = IS_MACOS ? "⌘" : "Ctrl+";

/** Spoken name for the same key, for screen readers, which differ on whether "⌘" is announced as
 *  "command" or skipped. */
export const MOD_KEY_SPOKEN = IS_MACOS ? "Command" : "Control";

/** True on Linux. WebKit2GTK's prefers-color-scheme query is unreliable, so
 *  the "system" theme option is hidden — Linux users pick dark or light. */
export const IS_LINUX = /Linux/.test(navigator.platform) && !/Android/.test(navigator.userAgent);
