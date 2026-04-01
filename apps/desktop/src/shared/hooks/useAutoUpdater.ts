import { useEffect, useRef } from "react";

import { useAppSettings } from "@/shared/context/AppSettingsContext";

/**
 * Checks for app updates on mount via the Tauri updater plugin.
 * Respects the autoCheckUpdates setting. Silently no-ops in test mode or on failure.
 */
export function useAutoUpdater() {
  const checked = useRef(false);
  const { autoCheckUpdates } = useAppSettings();

  useEffect(() => {
    if (checked.current) return;
    if (!autoCheckUpdates) return;
    checked.current = true;

    if (import.meta.env["VITE_TEST_MODE"] === "true") return;

    void (async () => {
      try {
        const { check } = await import("@tauri-apps/plugin-updater");
        const update = await check();
        if (update) {
          await update.downloadAndInstall();
        }
      } catch {
        // Silently fail — don't block the user if offline or update check errors
      }
    })();
  }, [autoCheckUpdates]);
}
