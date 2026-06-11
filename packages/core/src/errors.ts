// StorageError — typed error class for storage adapter rejections.
//
// The Rust backend serialises every command failure as `{ kind, message }`
// (see `apps/desktop/src-tauri/src/error.rs::AppError`). The adapter layer
// converts that wire shape into this class so UI code can branch on `kind`
// instead of string-matching `message`. `Unknown` is the fallback when the
// wire payload doesn't match the expected shape (rare — usually means a
// Tauri infrastructure error, not a command failure).

export type StorageErrorKind =
  | "Db"
  | "NotFound"
  | "Conflict"
  | "Io"
  | "Serde"
  | "Invalid"
  | "Internal"
  | "Unknown";

export class StorageError extends Error {
  readonly kind: StorageErrorKind;
  /** Original thrown value, if any — preserved so log scrubbing can fall
   *  back to a string representation that includes the raw cause. */
  readonly cause: unknown;

  constructor(kind: StorageErrorKind, message: string, cause?: unknown) {
    super(message);
    this.name = "StorageError";
    this.kind = kind;
    this.cause = cause;
  }
}

export function isStorageError(err: unknown): err is StorageError {
  return err instanceof StorageError;
}

/**
 * Best-effort conversion of an unknown thrown value (typically from the
 * Tauri IPC channel) into a StorageError. Recognises the Rust AppError
 * wire shape `{ kind, message }` and a plain `Error`. Falls back to
 * `Unknown` for anything else.
 */
export function toStorageError(err: unknown): StorageError {
  if (isStorageError(err)) return err;

  if (err !== null && typeof err === "object" && "kind" in err && "message" in err) {
    const obj = err as { kind: unknown; message: unknown };
    const kind = toStorageErrorKind(obj.kind);
    const message = typeof obj.message === "string" ? obj.message : String(obj.message);
    return new StorageError(kind, message, err);
  }

  if (err instanceof Error) {
    return new StorageError("Unknown", err.message, err);
  }

  return new StorageError("Unknown", String(err), err);
}

const KIND_SET: ReadonlySet<StorageErrorKind> = new Set<StorageErrorKind>([
  "Db",
  "NotFound",
  "Conflict",
  "Io",
  "Serde",
  "Invalid",
  "Internal",
  "Unknown",
]);

function toStorageErrorKind(raw: unknown): StorageErrorKind {
  if (typeof raw !== "string") return "Unknown";
  return (KIND_SET as Set<string>).has(raw) ? (raw as StorageErrorKind) : "Unknown";
}

/**
 * Human-friendly fallback message for each kind. UI surfaces should use
 * this (not the raw `message`) so users never see sqlx/Tauri text that
 * may echo user input. Callers can pass a `verb` to specialise the copy
 * ("saving page", "loading folders") without inventing per-kind strings.
 */
export function storageErrorUserMessage(err: StorageError, verb = "the operation"): string {
  switch (err.kind) {
    case "NotFound":
      return `Not found — refresh and try again.`;
    case "Conflict":
      return `Conflict while ${verb}. Try again in a moment.`;
    case "Io":
      return `Disk error while ${verb}. Check available space and permissions.`;
    case "Db":
      return `Storage error while ${verb}.`;
    case "Serde":
      return `Data shape mismatch while ${verb}. The workspace may need a restart.`;
    case "Invalid":
      return `Invalid input for ${verb}.`;
    case "Internal":
    case "Unknown":
    default:
      return `Something went wrong while ${verb}.`;
  }
}
