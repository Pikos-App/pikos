import { useEffect, useRef } from "react";

/**
 * Checks for app updates on mount via the Tauri updater plugin.
 * Silently no-ops in test mode or if the check fails (offline, etc.).
 */
export function useAutoUpdater() {
  const checked = useRef(false);

  useEffect(() => {
    if (checked.current) return;
    checked.current = true;

    if (import.meta.env["VITE_TEST_MODE"] === "true") return;

    void (async () => {
      try {
        const { check } = await import("@tauri-apps/plugin-updater");
        const update = await check();
        if (update?.available) {
          await update.downloadAndInstall();
        }
      } catch {
        // Silently fail — don't block the user if offline or update check errors
      }
    })();
  }, []);
}
