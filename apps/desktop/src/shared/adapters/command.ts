// One conversion for every Tauri command's rejection: the caller gets a StorageError that names the
// command, and pikos.log gets one content-free line saying which command failed and how.

import { type StorageError, toStorageError } from "@pikos/core";
import { invoke } from "@tauri-apps/api/core";

import { createLogger, throttled } from "@/shared/logger";

// Throttled because a command that keeps failing (a locked database under every write, a read
// behind each doorbell) would otherwise write a line per attempt.
const log = throttled(createLogger("IPC"));

export function commandFailed(command: string, err: unknown): StorageError {
  const error = toStorageError(err, command);
  log.warn(`${command} failed (${error.kind})`);
  return error;
}

/** `invoke`, for commands outside the storage adapter, with the same rejection as its own. */
export function invokeCommand<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  return invoke<T>(command, args).catch((err: unknown) => {
    throw commandFailed(command, err);
  });
}
