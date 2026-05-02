import js from "@eslint/js";
import perfectionist from "eslint-plugin-perfectionist";
import reactCompiler from "eslint-plugin-react-compiler";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/dist",
      "**/build",
      "**/node_modules",
      "scripts/**",
      "**/.astro",
      "apps/marketing/**",
    ],
  },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommendedTypeChecked],
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      parserOptions: {
        project: [
          "./apps/desktop/tsconfig.app.json",
          "./apps/desktop/tsconfig.node.json",
          "./packages/core/tsconfig.json",
          "./packages/ui/tsconfig.json",
        ],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      perfectionist,
      "react-compiler": reactCompiler,
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "react-hooks/exhaustive-deps": "off",
      "perfectionist/sort-imports": [
        "error",
        {
          type: "natural",
          groups: [
            "side-effect",
            "builtin",
            "external",
            "internal",
            ["parent", "sibling", "index"],
            "unknown",
          ],
        },
      ],
      "perfectionist/sort-named-imports": ["error", { type: "natural" }],
      "perfectionist/sort-exports": ["error", { type: "natural" }],
      "perfectionist/sort-objects": ["error", { type: "natural" }],
      "perfectionist/sort-jsx-props": ["error", { type: "natural" }],
      "react-compiler/react-compiler": "error",
      "react-refresh/only-export-components": ["warn", { allowConstantExport: true }],
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "no-console": "error",
    },
  },
  // Tests legitimately spy on console.* (e.g. suppressing React's expected
  // error logs when asserting hooks throw outside their provider).
  {
    files: ["**/*.test.{ts,tsx}", "**/*.spec.{ts,tsx}"],
    rules: {
      "no-console": "off",
    },
  },
  // logger.ts is the single allowed console site — it routes dev output to
  // console.* and prod output to tauri-plugin-log.
  {
    files: ["**/shared/logger.ts"],
    rules: {
      "no-console": "off",
    },
  },
  // shadcn/ui components export CVA variants alongside components — intentional pattern
  {
    files: ["**/components/ui/**/*.tsx"],
    rules: {
      "react-refresh/only-export-components": "off",
    },
  },
  // Tiptap editor files — moduleResolution: "bundler" prevents ESLint from resolving
  // Tiptap's complex chain/command generics. TypeScript (tsc) resolves them fine.
  // Suppress the false-positive unsafe-* rules for the editor feature directory.
  {
    files: ["**/features/editor/**/*.{ts,tsx}"],
    rules: {
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
    },
  },
  // SlashMenu exports both the React component and tiptap Extension/config from one file
  // (co-location of tightly coupled editor primitives). Fast refresh still works because
  // the extension is not a component — fast-refresh only-export warning is a false positive.
  {
    files: ["**/features/editor/components/SlashMenu.tsx"],
    rules: {
      "react-refresh/only-export-components": "off",
    },
  }
);
