// `VITE_TEST_MODE` answers one question: is this a browser with no Tauri shell
// around it. That is true of every e2e lane and stays true here. Which writer
// sits behind the storage adapter is a second, independent question, and
// collapsing the two into one flag is what kept the real writer unreachable
// from a spec: asking for real SQLite also asked for a Tauri runtime the
// browser does not have. The axes are named apart here, and this is the only
// place either one is read from the environment.

export const IS_TEST_MODE = import.meta.env["VITE_TEST_MODE"] === "true";

/** Which writer the adapter talks to. `mock` reimplements it in TypeScript; the
 *  other two reach the real one, over localhost and over IPC respectively. */
export type StorageBackend = "bridge" | "mock" | "tauri";

export const STORAGE_BACKEND: StorageBackend = !IS_TEST_MODE
  ? "tauri"
  : import.meta.env["VITE_E2E_STORAGE"] === "bridge"
    ? "bridge"
    : "mock";
