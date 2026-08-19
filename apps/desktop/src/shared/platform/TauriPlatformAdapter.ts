// The Tauri implementation of PlatformAdapter — the single file in the app
// that may reach for @tauri-apps/plugin-opener, -dialog, -fs, -process, the
// window/webview handles, or the shell-side commands. Everything else takes
// the interface from @/shared/platform.
//
// The plugin modules are imported lazily inside each method rather than at the
// top of the file. Two reasons: the dialog/fs/process plugins are only ever
// needed by paths the user has to reach first (import, delete-all-data), so
// they stay out of the entry chunk; and a plugin that is absent in a non-Tauri
// build fails at the call, not at module load, which keeps a browser preview
// booting instead of blanking.

import type {
  NativeFileDrop,
  PickFileOptions,
  PlatformAdapter,
  PlatformDirEntry,
  PlatformNotificationSettings,
  PlatformWindowAction,
} from "@pikos/core";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { appLogDir, join } from "@tauri-apps/api/path";

export class TauriPlatformAdapter implements PlatformAdapter {
  async openExternal(url: string): Promise<void> {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(url);
  }

  async openPath(path: string): Promise<void> {
    const { openPath } = await import("@tauri-apps/plugin-opener");
    await openPath(path);
  }

  async revealInDir(path: string): Promise<void> {
    const { revealItemInDir } = await import("@tauri-apps/plugin-opener");
    await revealItemInDir(path);
  }

  async openLogFile(): Promise<void> {
    await this.openPath(await join(await appLogDir(), "pikos.log"));
  }

  async relaunch(): Promise<void> {
    const { relaunch } = await import("@tauri-apps/plugin-process");
    await relaunch();
  }

  /** Swallows the failure into `null`: an OS that can't answer and a shell
   *  that isn't there are the same "unknown" from the settings panel's side. */
  async checkNotificationPermission(): Promise<boolean | null> {
    try {
      return await invoke<boolean>("check_notification_permission");
    } catch {
      return null;
    }
  }

  requestNotificationPermission(): Promise<boolean> {
    return invoke<boolean>("request_notification_permission");
  }

  async applyNotificationSettings(settings: PlatformNotificationSettings): Promise<void> {
    await invoke("update_notification_settings", { settings });
  }

  async pickDirectory(title: string): Promise<string | null> {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const selected = await open({ directory: true, multiple: false, title });
    return typeof selected === "string" ? selected : null;
  }

  async pickFile({ extensions, filterName, title }: PickFileOptions): Promise<string | null> {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const selected = await open({
      filters: [{ extensions, name: filterName }],
      multiple: false,
      title,
    });
    if (!selected) return null;
    return typeof selected === "string" ? selected : (selected[0] ?? null);
  }

  async readTextFile(path: string): Promise<string> {
    const { readTextFile } = await import("@tauri-apps/plugin-fs");
    return readTextFile(path);
  }

  async readDir(path: string): Promise<PlatformDirEntry[]> {
    const { readDir } = await import("@tauri-apps/plugin-fs");
    const entries = await readDir(path);
    return entries.map((e) => ({ isDirectory: e.isDirectory, name: e.name }));
  }

  async ensureAssetsDir(): Promise<void> {
    await invoke("init_assets_dir");
  }

  saveAsset(sourcePath: string): Promise<string> {
    return invoke<string>("save_asset", { sourcePath });
  }

  saveAssetBytes(data: Uint8Array, extension: string): Promise<string> {
    return invoke<string>("save_asset_bytes", { data: Array.from(data), ext: extension });
  }

  assetUrl(storedPath: string): string {
    return convertFileSrc(storedPath);
  }

  async onNativeFileDrop(handler: (drop: NativeFileDrop) => void): Promise<() => void> {
    const { getCurrentWebview } = await import("@tauri-apps/api/webview");
    return getCurrentWebview().onDragDropEvent((event) => {
      if (event.payload.type !== "drop") return;
      handler({ paths: event.payload.paths, position: event.payload.position });
    });
  }

  async setWindowDecorations(enabled: boolean): Promise<void> {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    await getCurrentWindow().setDecorations(enabled);
  }

  async windowAction(action: PlatformWindowAction): Promise<void> {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    await getCurrentWindow()[action]();
  }
}
