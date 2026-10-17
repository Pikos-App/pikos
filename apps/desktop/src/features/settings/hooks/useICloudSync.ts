import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useState } from "react";

export type ICloudSyncAction = "none" | "useThisAccount" | "uploadAgain";

export interface ICloudSyncState {
  on: boolean;
  text: string;
  action: ICloudSyncAction;
}

const STATUS_EVENT = "icloud-sync:status";

export interface ICloudSync {
  state: ICloudSyncState | null;
  error: string | null;
  setOn: (on: boolean) => Promise<void>;
  act: () => Promise<void>;
}

function readState(): Promise<ICloudSyncState> {
  return invoke<ICloudSyncState>("icloud_sync_state");
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
          if (!cancelled) setError(String(e));
        }
      );
    void pull();
    const unlisten = listen(STATUS_EVENT, () => void pull());
    return () => {
      cancelled = true;
      void unlisten.then((stop) => stop());
    };
  }, []);

  async function run(command: string, args?: Record<string, unknown>): Promise<void> {
    try {
      await invoke(command, args);
      setError(null);
    } catch (e) {
      setError(String(e));
    }
    setState(await readState());
  }

  return {
    act: () => run("icloud_sync_act"),
    error,
    setOn: (on) => run("icloud_sync_set", { on }),
    state,
  };
}
