/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: "no-cross-feature-imports",
      comment:
        "Features must not import directly from other features. Route shared code through src/shared/ instead.",
      severity: "error",
      from: {
        path: "(src/features/[^/]+)",
        // Suspensions, not amnesty: each entry is one anchored file whose
        // cross-feature import is a real design decision (where does the shared
        // thing live?) rather than a mechanical move, and each is being worked
        // on elsewhere right now. Reviewed 2026-08-19 — the rule stays strict
        // for every other file, and an entry should be deleted the moment its
        // import is rehomed.
        pathNot: [
          // 2026-08-19 — imports @/features/calendar and @/features/editor to
          // mount them side by side. layout is the app shell, so composing
          // sibling features is arguably its job; formalising that (a
          // shared/panels registry, or lazy element props passed in from App)
          // is the open question.
          "^apps/desktop/src/features/layout/components/EditorPanel\\.tsx$",
          // 2026-08-19 — imports @/features/folders for the folder picker in
          // the page-list header. Wants the folder chooser lifted into
          // shared/components, which means untangling it from folder state.
          "^apps/desktop/src/features/layout/components/PageListHeader\\.tsx$",
          // 2026-08-19 — imports @/features/pages to render the page list
          // itself. Same shell-composes-features question as EditorPanel.
          "^apps/desktop/src/features/layout/components/PageListPanel\\.tsx$",
          // 2026-08-19 — imports @/features/folders for the folder tree in the
          // sidebar. Same rehoming question as PageListHeader.
          "^apps/desktop/src/features/layout/components/Sidebar\\.tsx$",
          // 2026-08-19 — imports @/features/import for the import panel inside
          // the data settings screen. Settings hosts other features' panels by
          // design; the fix is a settings-panel registry, not a moved file.
          "^apps/desktop/src/features/settings/components/DataSettings\\.tsx$",
          // 2026-08-19 — same as DataSettings: mounts @/features/import.
          "^apps/desktop/src/features/settings/components/SettingsPage\\.tsx$",
        ],
      },
      to: {
        path: "src/features/",
        pathNot: [
          // $1 — the importing feature's own directory, from the capture group
          // in `from.path` above.
          "$1",
          // 2026-08-19 — features/calendar/components/CalendarView.tsx reads
          // the panel breakpoints from here. Pure constants with no layout
          // dependency: belongs in shared/, and moving it is a one-line change
          // in a file another work package is currently rewriting. Scoped to
          // this module rather than to CalendarView so the rest of CalendarView
          // stays policed.
          "^apps/desktop/src/features/layout/breakpoints\\.ts$",
          // 2026-08-19 — features/layout/hooks/useThreePanelDnD.ts reads the
          // active sort mode from here to decide whether a drop reorders.
          // The hook is state shared between the list and the shell that drags
          // it; it wants a home in shared/hooks or in a sort-mode context.
          "^apps/desktop/src/features/pages/hooks/useActiveSortMode\\.ts$",
        ],
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
      to: { path: "^apps/desktop/src/shared/adapters/TauriSQLiteAdapter" },
    },
    {
      name: "no-deep-generated-imports",
      comment:
        "packages/core/src/generated is regenerated wholesale by scripts/gen-ts-bindings.sh, so its file layout is whatever ts-rs emits. Import these types through the @pikos/core index instead — that re-export is the stable surface, and it is what keeps a Rust-side rename a one-file change on the TS side.",
      severity: "error",
      from: { path: "^apps/desktop/src/" },
      to: { path: "^packages/core/src/generated/" },
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
    // from (the repo root), and tsconfig.app.json extends ../../tsconfig.base.json,
    // which from here reads as apps/desktop/tsconfig.base.json and does not exist.
    // tsconfig.json extends nothing, so it survives the trip.
    //
    // Its `paths` only take effect because it also carries `baseUrl: "."`:
    // dependency-cruiser hands the file to tsconfig-paths, which needs a base to
    // resolve `@/*` -> `./src/*` against, and without one falls back to the cwd
    // (the repo root) where nothing matches. That baseUrl is free: tsconfig.json
    // is the solution file (`files: []`, references only), so tsc compiles
    // nothing through it and vite carries its own aliases — nothing but this
    // cruise reads those options.
    //
    // With that in place `@/…` imports resolve to real files, so every rule
    // above matches resolved repo-root-relative paths and none of them has to
    // pattern-match specifier spellings.
    tsConfig: {
      fileName: "apps/desktop/tsconfig.json",
    },
  },
};
