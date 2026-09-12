import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Tiptap builds a real ProseMirror view, which needs a DOM.
    environment: "jsdom",
  },
});
