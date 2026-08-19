// The host-shell seam. Everything the app asks of the machine it runs on that
// is *not* a read or write of workspace data lives here; workspace data goes
// through StorageAdapter (see storage.ts).
//
// The split is deliberate and the line is "does this touch the user's pages?":
//   - opening a URL, revealing a file, picking a folder, asking the OS for
//     notification permission, driving the window chrome → PlatformAdapter
//   - backing up / exporting / wiping the database, reading usage stats →
//     StorageAdapter
//
// Assets (images pasted or dropped into the editor) sit on this side even
// though they end up on disk next to the database: what the caller needs is a
// file copied into an app-managed location and a URL the webview can render,
// which on a phone is a share-sheet import + a content:// URI, not a SQL
// statement. Keeping them here means the editor extensions — plain modules
// with no React context to read from — need exactly one accessor.

/** Reminder/scheduler configuration handed to the host's notification engine. */
export interface PlatformNotificationSettings {
  defaultMinutesBefore: number;
  enabled: boolean;
  overdueAlerts: boolean;
  quietHoursEnabled: boolean;
  quietHoursEnd: string;
  quietHoursStart: string;
  summaryTime: string;
}

/** One entry from {@link PlatformAdapter.readDir}. */
export interface PlatformDirEntry {
  name: string;
  isDirectory: boolean;
}

/** Filter for {@link PlatformAdapter.pickFile}. `extensions` is bare (no dot). */
export interface PickFileOptions {
  title: string;
  filterName: string;
  extensions: string[];
}

/** Window-chrome commands the custom title bar issues. */
export type PlatformWindowAction = "minimize" | "toggleMaximize" | "close";

/** A native (OS-level, not HTML5) file drop onto the app surface. */
export interface NativeFileDrop {
  paths: string[];
  /** Physical device pixels — divide by devicePixelRatio for CSS coords. */
  position: { x: number; y: number };
}

export interface PlatformAdapter {
  // ─── Shell ────────────────────────────────────────────────────────────────
  /** Open a URL in the user's browser. */
  openExternal(url: string): Promise<void>;
  /** Open a path with its default application. */
  openPath(path: string): Promise<void>;
  /** Reveal a path in the OS file manager ("Show in Finder"). */
  revealInDir(path: string): Promise<void>;
  /** Open the app's own rotating log file. The host owns the path — callers
   *  never learn where logs live, which is the whole point of the method. */
  openLogFile(): Promise<void>;
  /** Restart the app process. No-op where the host has no such notion. */
  relaunch(): Promise<void>;

  // ─── Notifications ────────────────────────────────────────────────────────
  /** `null` means "the host can't tell us" — an unsupported OS, or no native
   *  shell at all. Distinct from `false`, which is a real denial. */
  checkNotificationPermission(): Promise<boolean | null>;
  /** Prompt the user. Rejects if the request itself could not be made. */
  requestNotificationPermission(): Promise<boolean>;
  /** Push the reminder settings to the host's scheduler. */
  applyNotificationSettings(settings: PlatformNotificationSettings): Promise<void>;

  // ─── Files ────────────────────────────────────────────────────────────────
  /** Native directory picker. `null` when the user cancels. */
  pickDirectory(title: string): Promise<string | null>;
  /** Native file picker. `null` when the user cancels. */
  pickFile(options: PickFileOptions): Promise<string | null>;
  readTextFile(path: string): Promise<string>;
  readDir(path: string): Promise<PlatformDirEntry[]>;

  // ─── Assets ───────────────────────────────────────────────────────────────
  /** Create the workspace's asset directory if it isn't there yet. */
  ensureAssetsDir(): Promise<void>;
  /** Copy a file into the asset store; resolves to its stored path. */
  saveAsset(sourcePath: string): Promise<string>;
  /** Write raw bytes into the asset store; resolves to its stored path. */
  saveAssetBytes(data: Uint8Array, extension: string): Promise<string>;
  /** Turn a stored asset path into something an <img src> can load. */
  assetUrl(storedPath: string): string;
  /** Subscribe to OS-level file drops onto the app. Resolves to an unsubscribe. */
  onNativeFileDrop(handler: (drop: NativeFileDrop) => void): Promise<() => void>;

  // ─── Window chrome ────────────────────────────────────────────────────────
  setWindowDecorations(enabled: boolean): Promise<void>;
  windowAction(action: PlatformWindowAction): Promise<void>;
}
