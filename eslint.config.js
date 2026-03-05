import js from "@eslint/js";
import reactCompiler from "eslint-plugin-react-compiler";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/dist", "**/build", "**/node_modules"] },
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
      "react-compiler": reactCompiler,
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "react-compiler/react-compiler": "error",
      "react-refresh/only-export-components": ["warn", { allowConstantExport: true }],
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  // shadcn/ui components export CVA variants alongside components — intentional pattern
  {
    files: ["**/components/ui/**/*.tsx"],
    rules: {
      "react-refresh/only-export-components": "off",
    },
  }
);
