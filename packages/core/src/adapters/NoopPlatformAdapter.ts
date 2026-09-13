// PlatformAdapter for environments with no host shell — unit tests and the
// VITE_TEST_MODE browser build the e2e suite drives.
//
// Every method resolves rather than throws, and each answer is chosen to match
// what the call sites already saw when the raw Tauri call failed in these
// environments: pickers cancel, permission is unknown rather than denied, and
// the shell verbs quietly do nothing. That keeps the mock path byte-identical
// to the behaviour the tests were written against.

import type {
  NativeFileDrop,
  PickFileOptions,
  PlatformAdapter,
  PlatformDirEntry,
  PlatformNotificationSettings,
  PlatformWindowAction,
} from "../platform";

export class NoopPlatformAdapter implements PlatformAdapter {
  /** Every call, in order, for tests that want to assert on the interaction. */
  readonly calls: { method: string; args: unknown[] }[] = [];

  private record(method: string, ...args: unknown[]): void {
    this.calls.push({ args, method });
  }

  openExternal(url: string): Promise<void> {
    this.record("openExternal", url);
    return Promise.resolve();
  }

  openPath(path: string): Promise<void> {
    this.record("openPath", path);
    return Promise.resolve();
  }

  revealInDir(path: string): Promise<void> {
    this.record("revealInDir", path);
    return Promise.resolve();
  }

  openLogFile(): Promise<void> {
    this.record("openLogFile");
    return Promise.resolve();
  }

  relaunch(): Promise<void> {
    this.record("relaunch");
    return Promise.resolve();
  }

  /** Unknown, not denied — there is no OS here to have an opinion. */
  checkNotificationPermission(): Promise<boolean | null> {
    this.record("checkNotificationPermission");
    return Promise.resolve(null);
  }

  requestNotificationPermission(): Promise<boolean> {
    this.record("requestNotificationPermission");
    return Promise.resolve(false);
  }

  applyNotificationSettings(settings: PlatformNotificationSettings): Promise<void> {
    this.record("applyNotificationSettings", settings);
    return Promise.resolve();
  }

  pickDirectory(title: string): Promise<string | null> {
    this.record("pickDirectory", title);
    return Promise.resolve(null);
  }

  pickFile(options: PickFileOptions): Promise<string | null> {
    this.record("pickFile", options);
    return Promise.resolve(null);
  }

  readTextFile(path: string): Promise<string> {
    this.record("readTextFile", path);
    return Promise.resolve("");
  }

  readDir(path: string): Promise<PlatformDirEntry[]> {
    this.record("readDir", path);
    return Promise.resolve([]);
  }

  ensureAssetsDir(): Promise<void> {
    this.record("ensureAssetsDir");
    return Promise.resolve();
  }

  /** Echoes the source path back: there is no store to copy into, and the
   *  editor only ever feeds the result to `assetUrl`, which is also identity. */
  saveAsset(sourcePath: string): Promise<string> {
    this.record("saveAsset", sourcePath);
    return Promise.resolve(sourcePath);
  }

  saveAssetBytes(data: Uint8Array, extension: string): Promise<string> {
    this.record("saveAssetBytes", data, extension);
    return Promise.resolve(`mock-asset-${this.calls.length}.${extension}`);
  }

  assetUrl(storedPath: string): string {
    return storedPath;
  }

  onNativeFileDrop(handler: (drop: NativeFileDrop) => void): Promise<() => void> {
    this.record("onNativeFileDrop", handler);
    return Promise.resolve(() => {});
  }

  setWindowDecorations(enabled: boolean): Promise<void> {
    this.record("setWindowDecorations", enabled);
    return Promise.resolve();
  }

  windowAction(action: PlatformWindowAction): Promise<void> {
    this.record("windowAction", action);
    return Promise.resolve();
  }
}
