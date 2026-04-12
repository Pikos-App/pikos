import { useEffect, useRef, useState } from "react";

import { useAppSettings } from "@/shared/context/AppSettingsContext";

// ─── Types ───────────────────────────────────────────────────────────────────

interface UpdateInfo {
  version: string;
  body: string;
  date: string | undefined;
}

export type UpdateStatus =
  | { state: "idle" }
  | { state: "checking" }
  | { state: "available"; update: UpdateInfo }
  | { state: "downloading" }
  | { state: "up-to-date" }
  | { state: "error"; message: string };

export interface AutoUpdater {
  status: UpdateStatus;
  /** Manually trigger an update check. */
  checkForUpdates: () => void;
  /** Skip the currently available version (won't prompt again). */
  skipVersion: () => void;
  /** Dismiss the dialog without skipping — will prompt again next launch. */
  dismiss: () => void;
  /** Download and install the available update, then restart. */
  installUpdate: () => void;
}

// ─── Hook ────────────────────────────────────────────────────────────────────

export function useAutoUpdater(): AutoUpdater {
  const autoChecked = useRef(false);
  const { setSkippedVersion, skippedVersion } = useAppSettings();
  const [status, setStatus] = useState<UpdateStatus>({ state: "idle" });

  async function doCheck() {
    if (import.meta.env["VITE_TEST_MODE"] === "true") return;

    // ── DEV MOCK: simulate an available update ──
    if (import.meta.env.DEV) {
      setStatus({ state: "checking" });
      await new Promise((r) => setTimeout(r, 1000));
      const mockVersion = "1.0.0";
      if (skippedVersion === mockVersion) {
        setStatus({ state: "idle" });
        return;
      }
      setStatus({
        state: "available",
        update: {
          body: "- New update dialog with release notes\n- Skip version support\n- Automatic update checks on launch",
          date: new Date().toISOString(),
          version: mockVersion,
        },
      });
      return;
    }
    // ── END DEV MOCK ──

    setStatus({ state: "checking" });
    try {
      const { check } = await import("@tauri-apps/plugin-updater");
      const update = await check();

      if (!update) {
        setStatus({ state: "up-to-date" });
        return;
      }

      if (skippedVersion === update.version) {
        setStatus({ state: "idle" });
        return;
      }

      setStatus({
        state: "available",
        update: {
          body: update.body ?? "",
          date: update.date,
          version: update.version,
        },
      });
    } catch (e: unknown) {
      setStatus({ message: String(e), state: "error" });
    }
  }

  async function doInstall() {
    if (status.state !== "available") return;

    setStatus({ state: "downloading" });

    // DEV MOCK: simulate download + restart
    if (import.meta.env.DEV) {
      await new Promise((r) => setTimeout(r, 2000));
      setStatus({ state: "idle" });
      return;
    }

    try {
      const { check } = await import("@tauri-apps/plugin-updater");
      const update = await check();
      if (!update) {
        setStatus({ state: "up-to-date" });
        return;
      }
      await update.downloadAndInstall();
      const { relaunch } = await import("@tauri-apps/plugin-process");
      await relaunch();
    } catch (e: unknown) {
      setStatus({ message: String(e), state: "error" });
    }
  }

  // Auto-check once on mount.
  useEffect(() => {
    if (autoChecked.current) return;
    autoChecked.current = true;
    void doCheck();
  }, []);

  function checkForUpdates() {
    void doCheck();
  }

  function skipVersion() {
    if (status.state === "available") {
      setSkippedVersion(status.update.version);
    }
    setStatus({ state: "idle" });
  }

  function dismiss() {
    setStatus({ state: "idle" });
  }

  function installUpdate() {
    void doInstall();
  }

  return { checkForUpdates, dismiss, installUpdate, skipVersion, status };
}
