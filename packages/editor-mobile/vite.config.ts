import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig, type Plugin } from "vite";

/**
 * Fold the built CSS and JS into index.html so the webview loads exactly one
 * document.
 *
 * Not cosmetic. The host serves these bytes through a WKURLSchemeHandler,
 * whose callbacks run on the main thread — the same thread that has to stay
 * responsive for typing. Every extra request is another hop through it during
 * the cold load that M0's pass bar measures (< 300 ms on iPhone 12-class
 * hardware). One document means one hop.
 *
 * Written here rather than pulled in as a plugin dependency: it is twenty lines
 * against a build output whose shape we control.
 */
const __dirname = dirname(fileURLToPath(import.meta.url));

function inlineEverything(): Plugin {
  return {
    apply: "build",
    enforce: "post",
    name: "pikos-inline-single-file",
    closeBundle() {
      const dir = resolve(__dirname, "dist");
      const htmlPath = resolve(dir, "index.html");
      let html = readFileSync(htmlPath, "utf8");
      const consumed = new Set<string>();

      // Driven off what the HTML actually references rather than off bundle
      // keys: the emitted tag is the only thing that has to end up inlined, and
      // matching on it cannot silently miss a file the bundler named
      // differently than expected.
      html = html.replace(
        /<script\b[^>]*\bsrc="([^"]+)"[^>]*><\/script>/g,
        (_tag, src: string) => {
          const file = resolve(dir, src.replace(/^\//, ""));
          consumed.add(file);
          // The closing tag has to be broken up or it terminates the script
          // element it is being embedded into.
          const code = readFileSync(file, "utf8").replace(/<\/script>/g, "<\\/script>");
          return `<script type="module">${code}</script>`;
        }
      );

      html = html.replace(
        /<link\b[^>]*\brel="stylesheet"[^>]*\bhref="([^"]+)"[^>]*>/g,
        (_tag, href: string) => {
          const file = resolve(dir, href.replace(/^\//, ""));
          consumed.add(file);
          return `<style>${readFileSync(file, "utf8")}</style>`;
        }
      );

      if (/<script\b[^>]*\bsrc=|<link\b[^>]*\brel="stylesheet"/.test(html)) {
        throw new Error("an external reference survived inlining — the webview would 404 on it");
      }

      writeFileSync(htmlPath, html);
      for (const file of consumed) rmSync(file, { force: true });
      rmSync(resolve(dir, "assets"), { force: true, recursive: true });
    },
  };
}

export default defineConfig({
  build: {
    // Inline url()-referenced assets too, so nothing is left to fetch.
    assetsInlineLimit: Number.MAX_SAFE_INTEGER,
    cssCodeSplit: false,
    outDir: "dist",
    // Safari 17 matches the iOS 17 deployment target; targeting lower would
    // ship transpilation the device does not need.
    target: "safari17",
  },
  plugins: [inlineEverything()],
});
