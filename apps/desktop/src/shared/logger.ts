// Single logger surface for the desktop app.
//
// All runtimes: routes to tauri-plugin-log → ~/Library/Logs/.../pikos.log
//   (rotating, 2 MB max, KeepOne strategy — see lib.rs). The file is the
//   source of truth when reconstructing a session from a bug report.
// Dev: ALSO mirrors to console.* so DevTools renders clickable stack traces.
// Tests: silenced; tests asserting log calls should spy on console directly.
//
// ─── Logging principle ──────────────────────────────────────────────────
//
// Logs exist to reconstruct a user's session from a bug report. Bias
// toward silence — anything added here ships to disk on every install.
//
// LOG these:
//   1. Boundaries where errors disappear. Every async catch, IPC call,
//      event handler, scheduler tick. If it can throw and nothing else
//      captures it (no React error boundary, no Promise consumer
//      rendering an error UI), log it.
//   2. Lifecycle anchors. App start, workspace open, DB migration done,
//      auto-update check / install, scheduler start. One INFO line each —
//      these are the timeline you scroll between when reading a log.
//   3. Destructive or audit-worthy actions. Reset, mass delete, workspace
//      switch, file exports. INFO with counts and destination — never
//      with content.
//   4. Silent branches. When code chooses based on env, OS, or stored
//      preference in a way the user can't see. DEBUG with the choice.
//
// DO NOT log:
//   - Per-event noise: keystrokes, debounced saves, individual queries,
//     page renders. If it fires more than ~10× per session it's noise.
//   - Happy-path success at fine grain ("page saved", "5 results").
//   - Anything containing user content: page text, titles, search
//     queries, file paths from the user, or error messages from foreign
//     systems (sqlite, Tauri commands) that may echo user input. The
//     scrubber is a backstop, not a license.
//
// ─── Severity ───────────────────────────────────────────────────────────
//
//   error — user-visible failure or silent corruption risk
//   warn  — fallback taken, unexpected state, recoverable
//   info  — lifecycle anchors and destructive actions
//   debug — diagnostic detail useful in dev only (stripped in prod)
//
// ─── Sensitive-data policy ─────────────────────────────────────────────
//
// formatError() scrubs home-dir paths from error messages and stacks. It
// does NOT scrub error messages from foreign systems that may echo user
// input. For those sites, pass `e.name` (just the class) not `e`.
//
// The msg argument MUST be app-controlled and short. Never interpolate
// page titles, search queries, or user-provided file paths into it.
//
// ─── When in doubt ─────────────────────────────────────────────────────
//
// Omit. The cost of a missing log is one back-and-forth with one user.
// The cost of a noisy log is broken signal-to-noise across every report.

const IS_DEV = import.meta.env.DEV;
const IS_TEST = import.meta.env["VITE_TEST_MODE"] === "true";

// Matches macOS, Linux, and Windows user-home prefixes. Replaces with "~"
// so log files don't leak the user's actual username.
const HOME_PATH_RE = /(\/Users\/[^/\s)]+|\/home\/[^/\s)]+|C:\\Users\\[^\\\s)]+)/g;

function scrubPaths(s: string): string {
  return s.replace(HOME_PATH_RE, "~");
}

// Per-field cap for formatError output. Keeps a single runaway third-party
// error (e.g. a JSON parser quoting the bad input) from dumping unbounded
// user-derived bytes into pikos.log via the global handlers in
// installGlobalErrorHandlers().
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

  // Dev: ALSO mirror to console.* so DevTools renders clickable stack traces.
  // This is in addition to — not instead of — the log-file write below. The
  // file is the source of truth for a bug report and must capture frontend
  // issues even when the console isn't open or available (manual QA runs on
  // unbundled `tauri dev` builds, where the console is the only other sink).
  if (IS_DEV) {
    if (err === undefined) fn[level](tag);
    else fn[level](tag, err);
  }

  // Write to the rotating log file via tauri-plugin-log in any Tauri runtime
  // (dev and prod alike). Dynamic import keeps the plugin out of non-Tauri
  // test bundles and avoids a top-level await on a Tauri command.
  void import("@tauri-apps/plugin-log")
    .then((log) => {
      const payload = err === undefined ? tag : `${tag} | ${formatError(err)}`;
      return log[level](payload);
    })
    .catch(() => {
      // Plugin unavailable (non-Tauri runtime, e.g. a browser context). Swallow.
    });
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

// Call once from main.tsx. Routes uncaught exceptions and unhandled promise
// rejections through the logger so they end up in the rotating log file.
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
