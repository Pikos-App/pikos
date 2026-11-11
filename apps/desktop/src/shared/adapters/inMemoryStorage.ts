// The split point for MockStorageAdapter.
//
// Nothing may import this module statically. Its only job is to be the target
// of an `import()` so the bundler puts the ~1,400-line in-memory adapter in a
// chunk of its own — a production build never runs in test mode, so it should
// never download it. A static import anywhere would pull the class straight
// back into the entry chunk and quietly undo that.

import { MockStorageAdapter } from "@pikos/core/testing";

export function createInMemoryStorage(): MockStorageAdapter {
  const adapter = new MockStorageAdapter();
  // `?seedPages=20000` fills the workspace before anything renders, so a perf run can time the
  // interface against a realistic row count. Test-mode only: this module is behind an import()
  // that a production build never reaches, and the parameter is ignored without a number.
  const params = new URLSearchParams(window.location.search);
  const seed = Number(params.get("seedPages"));
  if (Number.isFinite(seed) && seed > 0) {
    // `?bodyWords=` sizes each seeded page and `?bodyShape=log` picks a journal's shape over prose,
    // so the editor can be timed against a real document rather than a one-line one.
    const bodyWords = Number(params.get("bodyWords"));
    const bodyShape = params.get("bodyShape") === "log" ? "log" : "prose";
    adapter.seedPages(seed, {
      bodyShape,
      completedEvery: 5,
      ...(Number.isFinite(bodyWords) && bodyWords > 0 ? { bodyWords } : {}),
    });
    // Building two million objects takes seconds, and without this the scale benchmark reports
    // seeding and booting as one number and reads as though the app were slow.
    performance.mark("pikos:seeded");
    // Handed to the scale benchmark so it can time individual operations against a full workspace.
    // Only reachable when a seed was asked for, in a module a production build never loads.
    (window as unknown as { __pikosStorage?: unknown }).__pikosStorage = adapter;
  }
  return adapter;
}
