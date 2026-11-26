// The host-shell seam: what the app asks of the machine that does not read or write workspace
// data, which goes through StorageAdapter. Opening a URL, revealing a file, picking a folder,
// notification permission and window chrome are here; backing up, exporting and wiping the
// database are not.
//
// Assets (images pasted or dropped into the editor) sit here even though they end up beside the
// database: the caller needs a file copied into an app-managed location and a URL the webview
// can render, which on a phone is a share-sheet import and a content:// URI, not a SQL
// statement. It also gives the editor extensions, which are plain modules with no React context,
// exactly one accessor.

export interface PlatformNotificationSettings {
  defaultMinutesBefore: number;
  enabled: boolean;
  overdueAlerts: boolean;
  quietHoursEnabled: boolean;
  quietHoursEnd: string;
  quietHoursStart: string;
  summaryTime: string;
}

export interface PlatformDirEntry {
  name: string;
  isDirectory: boolean;
}

/** `extensions` is bare (no dot). */
export interface PickFileOptions {
  title: string;
  filterName: string;
  extensions: string[];
}

export type PlatformWindowAction = "minimize" | "toggleMaximize" | "close";

/** A native (OS-level, not HTML5) file drop onto the app surface. */
export interface NativeFileDrop {
  paths: string[];
  /** Physical device pixels: divide by devicePixelRatio for CSS coords. */
  position: { x: number; y: number };
}

export interface PlatformAdapter {
  openExternal(url: string): Promise<void>;
  openPath(path: string): Promise<void>;
  /** Reveal a path in the OS file manager. */
  revealInDir(path: string): Promise<void>;
  /** Open the app's own log file. The host owns the path, so callers never learn where logs
   *  live. */
  openLogFile(): Promise<void>;
  /** Reveal the directory holding the workspace snapshots. Host-owned like the log file, and
   *  because the only caller is the screen shown when the workspace will not open, where a path
   *  typed into the UI would be a macOS path shown to a Linux user. */
  openBackupsDir(): Promise<void>;
  /** No-op where the host has no such notion. */
  relaunch(): Promise<void>;

  /** `null` means the host can't tell us (an unsupported OS, or no native shell), which is
   *  distinct from `false`, a real denial. */
  checkNotificationPermission(): Promise<boolean | null>;
  /** Rejects if the request itself could not be made. */
  requestNotificationPermission(): Promise<boolean>;
  /** No-op where there are none. */
  openNotificationSettings(): Promise<void>;
  applyNotificationSettings(settings: PlatformNotificationSettings): Promise<void>;
  /** Tell the host the app can be navigated now. It holds a notification clicked while the app
   *  was closed until this call, so calling it late delays the page and calling it twice does
   *  nothing. */
  replayPendingNotificationClicks(): Promise<void>;

  /** `null` when the user cancels. */
  pickDirectory(title: string): Promise<string | null>;
  /** `null` when the user cancels. */
  pickFile(options: PickFileOptions): Promise<string | null>;
  readTextFile(path: string): Promise<string>;
  readDir(path: string): Promise<PlatformDirEntry[]>;

  ensureAssetsDir(): Promise<void>;
  /** Resolves to the stored path. */
  saveAsset(sourcePath: string): Promise<string>;
  /** Resolves to the stored path. */
  saveAssetBytes(data: Uint8Array, extension: string): Promise<string>;
  /** Turns a stored path into something an `<img src>` can load. */
  assetUrl(storedPath: string): string;
  /** Resolves to an unsubscribe. */
  onNativeFileDrop(handler: (drop: NativeFileDrop) => void): Promise<() => void>;

  setWindowDecorations(enabled: boolean): Promise<void>;
  windowAction(action: PlatformWindowAction): Promise<void>;
}
