import { storageErrorUserMessage, toStorageError } from "@pikos/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useState } from "react";

import { invokeCommand } from "@/shared/adapters/command";
import { createLogger } from "@/shared/logger";

const log = createLogger("iCloudSync");

export type ICloudSyncAction = "none" | "useThisAccount" | "uploadAgain";

export interface ICloudSyncState {
  on: boolean;
  text: string;
  action: ICloudSyncAction;
}

const STATUS_EVENT = "icloud-sync:status";
const READING = "reading the iCloud sync status";

export interface ICloudSync {
  state: ICloudSyncState | null;
  error: string | null;
  setOn: (on: boolean) => Promise<void>;
  act: () => Promise<void>;
  /** Resolves false when the report couldn't be made or copied, with `error` saying why. */
  copyReport: () => Promise<boolean>;
}

function readState(): Promise<ICloudSyncState> {
  return invokeCommand<ICloudSyncState>("icloud_sync_state");
}

function failed(e: unknown, verb: string): string {
  return storageErrorUserMessage(toStorageError(e), verb);
}

/** The Mac's iCloud sync switch and the line under it, kept current by the event the transport
 *  sends whenever the line changes. */
export function useICloudSync(): ICloudSync {
  const [state, setState] = useState<ICloudSyncState | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const pull = () =>
      readState().then(
        (next) => {
          if (!cancelled) setState(next);
        },
        (e: unknown) => {
          if (!cancelled) setError(failed(e, READING));
        }
      );
    void pull();
    const unlisten = listen(STATUS_EVENT, () => void pull()).catch((e: unknown) => {
      // The line then changes only when the panel is opened again.
      log.warn("listening for sync status failed", e);
      return null;
    });
    return () => {
      cancelled = true;
      void unlisten.then((stop) => stop?.());
    };
  }, []);

  // The line is read again either way: a refused switch still moved the state Rust holds.
  async function run(command: string, verb: string, args?: Record<string, unknown>) {
    let failure: string | null = null;
    try {
      await invokeCommand(command, args);
    } catch (e) {
      failure = failed(e, verb);
    }
    try {
      setState(await readState());
    } catch (e) {
      failure ??= failed(e, READING);
    }
    setError(failure);
  }

  async function copyReport(): Promise<boolean> {
    let report: string;
    try {
      report = await invokeCommand<string>("icloud_sync_report");
    } catch (e) {
      setError(failed(e, "making the sync report"));
      return false;
    }
    try {
      await navigator.clipboard.writeText(report);
    } catch (e) {
      log.warn("copying the sync report failed", e);
      setError("Couldn't copy the report to the clipboard. Try again.");
      return false;
    }
    setError(null);
    return true;
  }

  return {
    act: () => run("icloud_sync_act", "starting iCloud sync over"),
    copyReport,
    error,
    setOn: (on) => run("icloud_sync_set", `turning iCloud sync ${on ? "on" : "off"}`, { on }),
    state,
  };
}
