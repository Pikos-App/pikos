/**
 * Boots the production bundle under the CSP the packaged app actually enforces.
 *
 * Nothing else in the suite sees that policy. Every other spec runs against the
 * vite dev server, which serves `devCsp` — and `devCsp` carries 'unsafe-eval'
 * while the shipped `csp` does not. 0.4.0-beta.1 went out through that gap with
 * a window that never painted: the recurrence engine compiles WebAssembly at
 * import time, `script-src 'self'` denied it, and the throw took down the entry
 * module graph before a line of app code ran.
 *
 * The policy is read from tauri.conf.json, never copied here. A copy would keep
 * passing while the shipped app broke, which is exactly the failure this guards.
 *
 * Injection mirrors tauri-utils: a meta tag appended to the end of <head>, with
 * sha256 hashes of the inline scripts folded into script-src. Placement is
 * load-bearing. A meta CSP governs only what the parser reaches after it, so
 * injecting at the top of <head> would police the inline theme script the real
 * app never applies it to, and fail on a bundle the shipped binary runs fine.
 *
 * Violations are read two ways because neither half catches the other: WebKit
 * throws on a denied wasm compile without firing securitypolicyviolation, and a
 * blocked script or font fires the event without throwing. Both are asserted
 * before the render check, which degrades to "element not found" on a page that
 * never booted.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test } from "./fixtures";

declare global {
  interface Window {
    __cspViolations?: string[];
  }
}

const TAURI_CONF = join(import.meta.dirname, "..", "src-tauri", "tauri.conf.json");

function releaseCsp(): string {
  const conf = JSON.parse(readFileSync(TAURI_CONF, "utf8")) as {
    app: { security: { csp: string } };
  };
  return conf.app.security.csp;
}

/** sha256/base64 over LF-normalized script text — the hash browsers compute, and
 *  the one tauri-codegen's CspHashes emits for every inline script it finds. */
function inlineScriptHashes(html: string): string[] {
  const inlineScript = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
  return [...html.matchAll(inlineScript)].map((match) => {
    const body = (match[1] ?? "").replace(/\r\n?/g, "\n");
    return `'sha256-${createHash("sha256").update(body, "utf8").digest("base64")}'`;
  });
}

function withInlineHashes(csp: string, hashes: string[]): string {
  if (hashes.length === 0) return csp;
  return csp.replace(/script-src ([^;]*)/, (_, sources: string) =>
    `script-src ${sources} ${hashes.join(" ")}`
  );
}

test("the packaged CSP boots the app @csp-prod", async ({ page }) => {
  const csp = releaseCsp();

  await page.route(
    (url) => url.pathname === "/" || url.pathname === "/index.html",
    async (route) => {
      const response = await route.fetch();
      const html = await response.text();
      const meta = `<meta http-equiv="Content-Security-Policy" content="${withInlineHashes(csp, inlineScriptHashes(html))}">`;
      await route.fulfill({ body: html.replace("</head>", `${meta}</head>`), response });
    }
  );

  await page.addInitScript(() => {
    window.__cspViolations = [];
    document.addEventListener("securitypolicyviolation", (event) => {
      window.__cspViolations?.push(
        `${event.violatedDirective} blocked ${event.blockedURI || "an inline resource"}`
      );
    });
  });

  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await page.goto("/");

  expect(await page.evaluate(() => window.__cspViolations ?? [])).toEqual([]);
  expect(pageErrors).toEqual([]);
  await expect(page.getByRole("main", { name: "Workspace" })).toBeVisible();
});
