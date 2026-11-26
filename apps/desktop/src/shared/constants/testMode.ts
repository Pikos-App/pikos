// `VITE_TEST_MODE` answers one question: is this a browser with no Tauri shell around it. That
// is true of every e2e lane. Which writer sits behind the storage adapter is a second,
// independent question: collapsing the two into one flag would make asking for real SQLite also
// ask for a Tauri runtime the browser does not have. The axes are named apart here, and this is
// the only place either one is read from the environment.

// Stryker disable next-line ConditionalExpression: every test lane builds in test mode; only the packaged app reads false
export const IS_TEST_MODE = import.meta.env["VITE_TEST_MODE"] === "true";

/** `mock` reimplements the writer in TypeScript; the other two reach the real one, over localhost
 *  and over IPC. */
export type StorageBackend = "bridge" | "mock" | "tauri";

export const STORAGE_BACKEND: StorageBackend = !IS_TEST_MODE
  ? // Stryker disable next-line StringLiteral: only the packaged app is the tauri backend
    "tauri"
  : import.meta.env["VITE_E2E_STORAGE"] === "bridge"
    ? "bridge"
    : "mock";
