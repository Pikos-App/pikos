/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: "no-cross-feature-imports",
      comment:
        "Features must not import directly from other features. Route shared code through src/shared/ instead.",
      severity: "error",
      from: { path: "(src/features/[^/]+)" },
      to: {
        path: "src/features/",
        pathNot: "$1",
      },
    },
    {
      name: "core-no-tauri",
      comment:
        "packages/core must be framework-agnostic. Move any Tauri-specific code to apps/desktop/src/shared/adapters/.",
      severity: "error",
      from: { path: "^packages/core/src/" },
      to: { path: "^@tauri-apps" },
    },
    {
      name: "core-no-react",
      comment:
        "packages/core must be framework-agnostic. Move any React-specific code to apps/desktop/.",
      severity: "error",
      from: { path: "^packages/core/src/" },
      to: { path: "^react(-dom)?(/|$)" },
    },
    {
      name: "storage-adapter-through-interface",
      comment:
        "TauriSQLiteAdapter is one implementation of StorageAdapter, not the storage API. Only the adapters directory (its own module) and WorkspaceContext (which picks the concrete adapter at startup) may name it; everything else takes a StorageAdapter from the workspace context, which is what keeps features testable against MockStorageAdapter.",
      severity: "error",
      from: {
        path: "^apps/desktop/src/",
        pathNot: [
          "^apps/desktop/src/shared/adapters/",
          "^apps/desktop/src/shared/context/WorkspaceContext\\.tsx$",
        ],
      },
      // Matched against the *resolved* path, which for a `@/…` specifier is the
      // specifier itself (see the alias note in options below) — so both the
      // aliased and the relative spelling have to be covered.
      to: { path: "(^|/)shared/adapters/TauriSQLiteAdapter" },
    },
    {
      name: "no-deep-generated-imports",
      comment:
        "packages/core/src/generated is regenerated wholesale by scripts/gen-ts-bindings.sh, so its file layout is whatever ts-rs emits. Import these types through the @pikos/core index instead — that re-export is the stable surface, and it is what keeps a Rust-side rename a one-file change on the TS side.",
      severity: "error",
      from: { path: "^apps/desktop/src/" },
      to: { path: "(^|/)core/(src/)?generated/" },
    },
  ],

  options: {
    doNotFollow: {
      path: "node_modules",
    },
    // The generated bindings are type-only exports, and so are most of the types
    // features pass around. Without this, `import type` is erased before
    // dependency-cruiser ever sees it and every rule below is blind to exactly
    // the imports it exists to police.
    tsPreCompilationDeps: true,
    // apps/desktop/tsconfig.json — not tsconfig.app.json — because
    // dependency-cruiser resolves `extends` relative to the cwd it is invoked
    // from (the repo root), and tsconfig.app.json extends ../../tsconfig.base.json.
    //
    // Its `paths` still do not take effect for the same reason: `@/*` maps to
    // `./src/*`, which from the repo root points nowhere. A `@/…` import is
    // therefore reported unresolved, with `resolved` left as the raw specifier.
    // Rules that need to match those imports must match the specifier shape too
    // — see the `to.path` patterns above.
    tsConfig: {
      fileName: "apps/desktop/tsconfig.json",
    },
  },
};
