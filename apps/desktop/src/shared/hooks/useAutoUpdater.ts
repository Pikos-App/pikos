import { useEffect, useRef, useState } from "react";

import { useAppSettings } from "@/shared/context/AppSettingsContext";
import { createLogger } from "@/shared/logger";

const log = createLogger("AutoUpdater");

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
    if (import.meta.env.DEV) return;

    log.info("Checking for updates");
    setStatus({ state: "checking" });
    try {
      const { check } = await import("@tauri-apps/plugin-updater");
      const update = await check();

      if (!update) {
        log.info("Up to date");
        setStatus({ state: "up-to-date" });
        return;
      }

      if (skippedVersion === update.version) {
        log.info(`Update available (${update.version}) but version skipped by user`);
        setStatus({ state: "idle" });
        return;
      }

      log.info(`Update available: ${update.version}`);
      setStatus({
        state: "available",
        update: {
          body: update.body ?? "",
          date: update.date,
          version: update.version,
        },
      });
    } catch (e: unknown) {
      // Updater errors can include URLs from the GitHub Releases response —
      // log only the class to keep them out of the file. Full string still
      // shows in the UI for the user.
      log.error("Update check failed", e instanceof Error ? e.name : "unknown");
      setStatus({ message: String(e), state: "error" });
    }
  }

  async function doInstall() {
    if (status.state !== "available") return;

    const targetVersion = status.update.version;
    log.info(`Installing update ${targetVersion}`);
    setStatus({ state: "downloading" });

    try {
      const { check } = await import("@tauri-apps/plugin-updater");
      const update = await check();
      if (!update) {
        setStatus({ state: "up-to-date" });
        return;
      }
      await update.downloadAndInstall();
      log.info(`Update ${targetVersion} installed, relaunching`);
      const { relaunch } = await import("@tauri-apps/plugin-process");
      await relaunch();
    } catch (e: unknown) {
      log.error("Update install failed", e instanceof Error ? e.name : "unknown");
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
