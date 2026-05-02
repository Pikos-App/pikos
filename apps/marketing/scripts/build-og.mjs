// Renders apps/marketing/public/og.png from the marketing site's design tokens.
// Re-run after token changes: pnpm --filter @pkos/marketing build:og
//
// Composition: logo + wordmark centered horizontally on the canvas, with the
// tagline on a single line below — sized to roughly match the head row's width
// so both rows read as a balanced, symmetric block.
//
// Tokens mirrored (keep in sync with src/styles/global.css and src/layouts/Base.astro):
//   bg                #161613              neutral-900 (warm-black)
//   glow              rgba(232,164,76,.14) warning-400 amber, dark-mode ambient glow
//   wordmark color    #f0efed              neutral-100
//   tagline muted     #908f8a              neutral-400
//   accent + logo     #c06a58              brand-400 (dark mode)

import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(__dirname, "../public/og.png");

// Playwright lives in apps/desktop's node_modules (not duplicated in marketing).
const requireFromDesktop = createRequire(resolve(__dirname, "../../desktop/package.json"));
const { chromium } = requireFromDesktop("@playwright/test");

const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link
      rel="stylesheet"
      href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap"
    />
    <style>
      * { margin: 0; padding: 0; box-sizing: border-box; }
      html, body { width: 1200px; height: 630px; }
      body {
        position: relative;
        overflow: hidden;
        background: #161613;
        font-family: "Inter", -apple-system, system-ui, sans-serif;
        -webkit-font-smoothing: antialiased;
        -moz-osx-font-smoothing: grayscale;
      }
      /* Mirrors Base.astro ambient glow — amber, anchored top-right, mostly off-canvas. */
      .glow {
        position: absolute;
        top: -180px;
        right: -260px;
        width: 1100px;
        height: 1100px;
        background: radial-gradient(
          circle at top right,
          rgba(232, 164, 76, 0.14),
          transparent 65%
        );
        pointer-events: none;
      }
      .stage {
        position: absolute;
        inset: 0;
        display: flex;
        align-items: center;
        justify-content: center;
      }
      .stage > div { transform: translateY(8px); }
      .composition {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 28px;
      }
      .head {
        display: flex;
        align-items: center;
        gap: 30px;
      }
      .logo { width: 148px; height: 148px; flex-shrink: 0; }
      .word {
        color: #f0efed;
        font-size: 142px;
        font-weight: 700;
        line-height: 0.95;
        letter-spacing: -0.045em;
      }
      .tagline {
        color: #908f8a;
        font-size: 32px;
        font-weight: 500;
        line-height: 1;
        letter-spacing: -0.015em;
        white-space: nowrap;
      }
      .tagline .accent {
        color: #c06a58;
        font-weight: 600;
        margin-left: 8px;
      }
    </style>
  </head>
  <body>
    <div class="glow" aria-hidden="true"></div>
    <div class="stage">
      <div>
        <div class="composition">
          <div class="head">
            <svg class="logo" viewBox="0 0 200 200" aria-hidden="true">
              <rect x="90" y="36" width="80" height="108" rx="9"
                    fill="none" stroke="#c06a58" stroke-width="12" opacity="0.6" />
              <rect x="60" y="54" width="80" height="108" rx="9"
                    fill="none" stroke="#c06a58" stroke-width="12" opacity="0.9" />
              <rect x="30" y="72" width="80" height="108" rx="9" fill="#c06a58" />
            </svg>
            <div class="word">Pikos</div>
          </div>
          <div class="tagline">
            Notes, tasks, and calendar.<span class="accent">One app.</span>
          </div>
        </div>
      </div>
    </div>
  </body>
</html>`;

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1200, height: 630 },
  deviceScaleFactor: 2,
});
const page = await context.newPage();
await page.setContent(html, { waitUntil: "networkidle" });
await page.evaluate(() => document.fonts.ready);

await page.screenshot({
  path: OUT,
  type: "png",
  clip: { x: 0, y: 0, width: 1200, height: 630 },
  omitBackground: false,
});

await browser.close();
console.log(`wrote ${OUT}`);
