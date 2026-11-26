import { useEffect, useRef, useState } from "react";

import { useAppSettings } from "@/shared/context/AppSettingsContext";
import { createLogger } from "@/shared/logger";
import { flushPendingWrites } from "@/shared/pendingWrites";

const log = createLogger("AutoUpdater");

interface UpdateInfo {
  version: string;
  body: string;
  date: string | undefined;
}

type UpdateStatus =
  | { state: "idle" }
  | { state: "checking" }
  | { state: "available"; update: UpdateInfo }
  | { state: "downloading" }
  | { state: "up-to-date" }
  | { state: "error"; message: string; scope: "check" | "install" };

export interface AutoUpdater {
  status: UpdateStatus;
  checkForUpdates: () => void;
  skipVersion: () => void;
  dismiss: () => void;
  installUpdate: () => void;
}

export function useAutoUpdater(): AutoUpdater {
  const autoChecked = useRef(false);
  const { autoUpdateEnabled, setSkippedVersion, skippedVersion } = useAppSettings();
  const [status, setStatus] = useState<UpdateStatus>({ state: "idle" });

  async function doCheck({ ignoreSkip = false } = {}) {
    if (import.meta.env["VITE_TEST_MODE"] === "true") return;
    if (import.meta.env.DEV) return;
    // The bench relaunches hundreds of times, and GitHub counts each check as a download of the manifest.
    if (__PIKOS_BENCH__) return;
    if (__PIKOS_NO_UPDATER__) return;

    log.info("Checking for updates");
    setStatus({ state: "checking" });
    try {
      const { check } = await import("@tauri-apps/plugin-updater");
      // Without a timeout a stalled request hangs check() forever. Don't add one to doInstall's
      // check(): the plugin carries it onto the Update and applies it to the download request,
      // which would abort slow, legitimate downloads.
      const update = await check({ timeout: 10_000 });

      if (!update) {
        log.info("Up to date");
        setStatus({ state: "up-to-date" });
        return;
      }

      if (!ignoreSkip && skippedVersion === update.version) {
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
      // Updater errors can include URLs from the GitHub Releases response, so only the class is logged.
      log.error("Update check failed", e instanceof Error ? e.name : "unknown");
      setStatus({
        message: "Couldn't check for updates. Check your network connection and try again.",
        scope: "check",
        state: "error",
      });
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
      // Relaunch restarts the process without closing the window, so the write queue's close-time
      // flush never runs, and the user likely has an editor full of unsaved text.
      await flushPendingWrites();
      await update.downloadAndInstall();
      log.info(`Update ${targetVersion} installed, relaunching`);
      const { relaunch } = await import("@tauri-apps/plugin-process");
      await relaunch();
    } catch (e: unknown) {
      log.error("Update install failed", e instanceof Error ? e.name : "unknown");
      setStatus({
        message: "Couldn't install the update. Try again, or download the latest from pikos.app.",
        scope: "install",
        state: "error",
      });
    }
  }

  // Skipped when auto-update is disabled: the updater plugin is never imported and no request is
  // issued. Manual `checkForUpdates()` ignores this gate.
  useEffect(() => {
    if (autoChecked.current) return;
    autoChecked.current = true;
    if (!autoUpdateEnabled) return;
    void doCheck();
  }, []);

  function checkForUpdates() {
    void doCheck({ ignoreSkip: true });
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
