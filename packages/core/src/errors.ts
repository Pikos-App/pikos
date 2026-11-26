// Every variant of the Rust AppError (`apps/desktop/src-tauri/src/error.rs`), and nothing else.
// A kind missing here is silently downgraded to "Unknown" by the mapper below, which reads to
// the user as "Something went wrong", so an offline sync would look identical to a bug.
export type StorageErrorKind =
  | "Db"
  | "NotFound"
  | "Conflict"
  | "Io"
  | "Serde"
  | "Invalid"
  | "Network"
  | "Corrupt"
  | "TooNew"
  | "Internal"
  | "Unknown";

export class StorageError extends Error {
  readonly kind: StorageErrorKind;
  /** The original thrown value, kept so log scrubbing can fall back to its string form. */
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
 * Converts a thrown value into a StorageError so UI code can branch on `kind` instead of
 * string-matching `message`. Reads the backend's `{ kind, message }` wire shape; a plain `Error`
 * or anything else becomes `Unknown`.
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
  "Network",
  "Corrupt",
  "TooNew",
  "Internal",
  "Unknown",
]);

function toStorageErrorKind(raw: unknown): StorageErrorKind {
  if (typeof raw !== "string") return "Unknown";
  return (KIND_SET as Set<string>).has(raw) ? (raw as StorageErrorKind) : "Unknown";
}

/**
 * User-facing message for each kind. Show this, not the raw `message`, which may carry
 * sqlx/Tauri text that echoes user input. `verb` ("saving page") specialises the copy.
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
    case "Network":
      return `Couldn't reach the network while ${verb}. Check your connection.`;
    case "Corrupt":
      return `The workspace file is damaged. Restore a backup from Settings → Data.`;
    case "TooNew":
      return `A newer Pikos updated this workspace. Update Pikos to open it.`;
    case "Internal":
    case "Unknown":
    default:
      return `Something went wrong while ${verb}.`;
  }
}
