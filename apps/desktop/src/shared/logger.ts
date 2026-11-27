// Logs go to the rotating pikos.log through tauri-plugin-log, the source of truth when
// reconstructing a session from a bug report. Dev also mirrors to console.*; tests are silenced,
// so a test asserting log calls spies on console directly.
//
// Bias toward silence: anything added here ships to disk on every install.
//
// Log:
//   - Boundaries where errors disappear: every async catch, IPC call, event handler, scheduler
//     tick, if nothing else captures the failure.
//   - Lifecycle anchors (app start, workspace open, migration done, update check, scheduler start),
//     one INFO line each.
//   - Destructive or audit-worthy actions (reset, mass delete, workspace switch, exports): INFO
//     with counts and destination, never content.
//   - Silent branches chosen from env, OS or stored preference: DEBUG with the choice.
//
// Do not log per-event noise (keystrokes, debounced saves, queries, renders; more than ~10 per
// session is noise), fine-grained happy-path success, or anything holding user content. The
// scrubber is a backstop, not a license.
//
// Severity: error is a user-visible failure or silent corruption risk; warn a recoverable
// fallback or unexpected state; info lifecycle anchors and destructive actions; debug dev-only
// detail, stripped in prod.
//
// Pass the error itself as `err`. formatError() prints a StorageError, or the backend's raw
// `{ kind, message }`, as its kind and command only, because the message is the Rust error's text
// and can quote SQL parameters. For anything else it prints the message with home-dir paths, URLs
// and email addresses scrubbed, so a foreign error that quotes a file name (a plugin's path, which
// can be a note's title) must be wrapped with toStorageError() first. The msg argument must be
// app-controlled and short, never page titles, search queries or user file paths.

import { isStorageError } from "@pikos/core";

const IS_DEV = import.meta.env.DEV;
const IS_TEST = import.meta.env["VITE_TEST_MODE"] === "true";

// Replaces user-home prefixes on macOS, Linux and Windows with "~" so log files don't leak the
// username.
const HOME_PATH_RE = /(\/Users\/[^/\s)]+|\/home\/[^/\s)]+|C:\\Users\\[^\\\s)]+)/g;
// A calendar server's address or an account's email can ride in a sync or updater error. The
// webview's own origin is left alone: every stack frame names it, with the line that threw.
const URL_RE = /\bhttps?:\/\/(?!(?:tauri\.)?localhost\b|127\.0\.0\.1\b)[^\s)"'>]+/gi;
const EMAIL_RE = /[^\s@()<>"',;:]+@[^\s@()<>"',;:]+\.[a-z]{2,}/gi;

function scrub(s: string): string {
  return s.replace(URL_RE, "<url>").replace(EMAIL_RE, "<email>").replace(HOME_PATH_RE, "~");
}

// Per-field cap for formatError output, so a runaway third-party error (a JSON parser quoting
// the bad input) can't dump unbounded user-derived bytes into pikos.log.
const MAX_FIELD_CHARS = 200;

function truncate(s: string, max = MAX_FIELD_CHARS): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** How many `cause` links are followed, so a cycle can't hang the logger. */
const MAX_CAUSE_DEPTH = 3;

/** The backend's AppError as it arrives over IPC, before anything converted it. */
function wireKind(e: unknown): string | null {
  if (e === null || typeof e !== "object" || !("kind" in e) || !("message" in e)) return null;
  const { kind } = e as { kind: unknown };
  return typeof kind === "string" && /^[A-Za-z]{1,32}$/.test(kind) ? kind : "?";
}

function causeOf(e: Error): unknown {
  return (e as { cause?: unknown }).cause;
}

export function formatError(e: unknown, depth = 0): string {
  if (isStorageError(e)) {
    const head = e.command
      ? `StorageError(${e.kind}) from ${e.command}`
      : `StorageError(${e.kind})`;
    // Only a cause JS threw is followed: the backend's own `{ kind, message }` would print the text
    // this branch leaves out.
    const cause = e.cause instanceof Error && depth < MAX_CAUSE_DEPTH ? e.cause : null;
    return cause ? `${head}\ncaused by: ${formatError(cause, depth + 1)}` : head;
  }
  const kind = wireKind(e);
  if (kind) return `AppError(${kind})`;
  if (e instanceof Error) {
    const name = e.name || "Error";
    const message = truncate(scrub(e.message ?? ""));
    const stack = e.stack ? truncate(scrub(e.stack)) : "";
    const line = stack ? `${name}: ${message}\n${stack}` : `${name}: ${message}`;
    const cause = causeOf(e);
    return cause !== undefined && depth < MAX_CAUSE_DEPTH
      ? `${line}\ncaused by: ${formatError(cause, depth + 1)}`
      : line;
  }
  if (typeof e === "string") return truncate(scrub(e));
  try {
    return truncate(scrub(JSON.stringify(e)));
  } catch {
    return "(unserializable)";
  }
}

type Level = "debug" | "info" | "warn" | "error";

export interface Logger {
  debug: (msg: string, err?: unknown) => void;
  error: (msg: string, err?: unknown) => void;
  info: (msg: string, err?: unknown) => void;
  warn: (msg: string, err?: unknown) => void;
}

const fn = {
  debug: console.debug,
  error: console.error,
  info: console.info,
  warn: console.warn,
};

function emit(level: Level, scope: string, msg: string, err?: unknown): void {
  if (IS_TEST) return;

  const tag = `[${scope}] ${msg}`;

  // The log-file write below still runs in dev: the file is the source of truth and must capture
  // frontend issues when the console isn't open (unbundled `tauri dev` QA).
  if (IS_DEV) {
    if (err === undefined) fn[level](tag);
    else fn[level](tag, err);
  }

  // Dynamic import keeps the plugin out of non-Tauri test bundles and avoids a top-level await.
  void import("@tauri-apps/plugin-log")
    .then((log) => {
      const payload = err === undefined ? tag : `${tag} | ${formatError(err)}`;
      return log[level](payload);
    })
    .catch(() => {});
}

export function createLogger(scope: string): Logger {
  return {
    debug: (msg, err) => emit("debug", scope, msg, err),
    error: (msg, err) => emit("error", scope, msg, err),
    info: (msg, err) => emit("info", scope, msg, err),
    warn: (msg, err) => emit("warn", scope, msg, err),
  };
}

const THROTTLE_MS = 30_000;

/**
 * A logger for a failure that can repeat on every write or tick: the first line for a message is
 * written, then at most one per `windowMs`, saying how many it held back. Keyed by `msg`, so a
 * message that names what failed keeps each failure's first line.
 */
export function throttled(log: Logger, windowMs = THROTTLE_MS): Logger {
  const last = new Map<string, { at: number; held: number }>();
  function write(level: Level, msg: string, err?: unknown): void {
    const now = Date.now();
    const seen = last.get(msg);
    if (seen && now - seen.at < windowMs) {
      seen.held += 1;
      return;
    }
    last.set(msg, { at: now, held: 0 });
    const held = seen?.held ?? 0;
    log[level](held > 0 ? `${msg} (and ${held} more since the last line)` : msg, err);
  }
  return {
    debug: (msg, err) => write("debug", msg, err),
    error: (msg, err) => write("error", msg, err),
    info: (msg, err) => write("info", msg, err),
    warn: (msg, err) => write("warn", msg, err),
  };
}

let globalHandlersInstalled = false;

export function installGlobalErrorHandlers(): void {
  if (globalHandlersInstalled) return;
  globalHandlersInstalled = true;
  const log = createLogger("Global");

  window.addEventListener("error", (event) => {
    log.error("Uncaught exception", event.error ?? event.message);
  });

  window.addEventListener("unhandledrejection", (event) => {
    log.error("Unhandled promise rejection", event.reason);
  });
}
