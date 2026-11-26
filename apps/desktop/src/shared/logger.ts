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
// formatError() scrubs home-dir paths but not error messages from foreign systems (sqlite, Tauri
// commands) that may echo user input: for those sites pass `e.name`, not `e`. The msg argument
// must be app-controlled and short, never page titles, search queries or user file paths.

const IS_DEV = import.meta.env.DEV;
const IS_TEST = import.meta.env["VITE_TEST_MODE"] === "true";

// Replaces user-home prefixes on macOS, Linux and Windows with "~" so log files don't leak the
// username.
const HOME_PATH_RE = /(\/Users\/[^/\s)]+|\/home\/[^/\s)]+|C:\\Users\\[^\\\s)]+)/g;

function scrubPaths(s: string): string {
  return s.replace(HOME_PATH_RE, "~");
}

// Per-field cap for formatError output, so a runaway third-party error (a JSON parser quoting
// the bad input) can't dump unbounded user-derived bytes into pikos.log.
const MAX_FIELD_CHARS = 200;

function truncate(s: string, max = MAX_FIELD_CHARS): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

export function formatError(e: unknown): string {
  if (e instanceof Error) {
    const name = e.name || "Error";
    const message = truncate(scrubPaths(e.message ?? ""));
    const stack = e.stack ? truncate(scrubPaths(e.stack)) : "";
    return stack ? `${name}: ${message}\n${stack}` : `${name}: ${message}`;
  }
  if (typeof e === "string") return truncate(scrubPaths(e));
  try {
    return truncate(scrubPaths(JSON.stringify(e)));
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
