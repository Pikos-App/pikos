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
  ],

  options: {
    doNotFollow: {
      path: "node_modules",
    },
    tsConfig: {
      fileName: "apps/desktop/tsconfig.json",
    },
  },
};
