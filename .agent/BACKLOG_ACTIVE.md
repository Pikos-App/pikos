# Pikos — Active Backlog

Working queue from Phase 2 through Public Launch. Ordered by the sequence things need to ship.
For post-launch specs — grep `BACKLOG.md` by GOO number.

Status: `[ ]` pending · Delete task when done.

---

## Refinement (to fix)
- [ ] editor refinements - see list in claude code
- [ ] refine tutorial content (recommended flow / new features? / keyboard shortcuts for non mac? maybe not worth it)
- [ ] tab and focus styling behavior, tab group and focus trap components?
- [ ] compact pageblock children rendering
- [ ] selecting in editor focuses to last character
- [ ] test auto updater
- [ ] complete shortcut (c, space/enter - which?)
- [ ] Misc dogfooding improvements.

## To test
- page multi select: should click outside page list items clear multi select?
- test page with a TON of content

Potential Editor Bugs - to confirm and fix.
  1. white-space: pre-wrap may preserve unwanted whitespace from pasted content                                                       
  - File: editor.css:53-57                                                                                                            
  - We added white-space: pre-wrap to paragraphs/headings to make Tab spaces visible, but this also preserves any whitespace in pasted
   text (e.g., copying from a webpage with multiple spaces or tabs)                                                                   
  - Validate: Copy text from a webpage or email that has irregular spacing, paste into the editor. Check if extra whitespace is       
  preserved that shouldn't be.                                                                                                              
  2. Unordered list bullet positioning may break at indent levels or with nested lists
  - File: editor.css:78-88                                                                                                            
  - We replaced native ::marker with a ::before pseudo-element at left: -16px. This is absolute-positioned relative to the li, which  
  may not align correctly when lists are nested or when a paragraph inside the list has an indent level.                              
  - Validate: Create a nested unordered list (3+ levels deep). Check if bullets are visible and properly aligned at each level.       
  3. Clicking below content when editor is already focused no longer moves cursor to end                                              
  - File: EditorPane.tsx:269-274                                                                                                      
  - The onMouseDown fix now checks !editor?.isFocused, so clicking the empty area below text while already editing does nothing.      
  Previously onClick always moved cursor to end. Some editors (like Notion) do let you click below to place cursor at end.            
  - Validate: Type a short paragraph, then click in the empty space far below it. Does the cursor move to the end of the text? Is this
   the behavior you want?                                                                                                             
  4. LinkPopover input type="url" rejects scheme-less URLs during typing
  - File: LinkPopover.tsx                                                                                                             
  - The URL input uses type="url" which applies browser validation. Typing "example.com" shows as invalid (red outline on some
  browsers) even though ensureProtocol() adds the scheme on submit.                                                                   
  - Validate: Open format toolbar, click link, type "google.com" without "https://". Does the input show error styling? Does submit   
  5. Find-in-page highlight colors are hardcoded yellow — may lack contrast in dark mode
  - File: editor.css:258-267                                                                                                          
  - The .find-match uses oklch(0.75 0.15 85) which is a warm yellow. Worth checking if it's visible enough against your dark          
  background.                                                                                                                         
  - Validate: Use Cmd+F in the editor, search for a word. Are the highlights clearly visible?                                         
                                                                                             
  6. Editor destroy guard missing on page switch                                                                                      
  - File: EditorPane.tsx:136                                                                                                          
  - The page-switch effect checks if (!editor || isLoading) but not editor.isDestroyed. If the editor is destroyed during a rapid page
   switch, commands like clearContent/setContent could throw.                                                                         
  - Validate: Rapidly click between 5+ pages in the sidebar as fast as possible. Check the dev console for errors. 

## Import before launch?

## Distribution & Public Launch

- [ ] 🧑 **Enroll in Apple Developer Program** — $99/yr, gating dependency for all signing/notarization. See `BACKLOG_DISTRIBUTION.md` for full steps.
- [ ] 🧑 **Register bundle identifier** — `app.pikos.desktop` in Apple Developer portal. Must match `tauri.conf.json`.
- [ ] 🧑 **Generate macOS code signing certificates** — Developer ID Application cert for direct distribution.
- [ ] 🤖 **Audit bundle identifier in tauri.conf.json** — Ensure identifier, productName, version are set correctly.
- [ ] 🧑🤖 **GOO-52A: GitHub Actions release workflow** — Signed, notarized macOS builds on git tag push. See `BACKLOG_DISTRIBUTION.md`.
- [ ] 🤖 **GOO-52B: Tauri auto-updater** — Generate keypair, configure updater plugin, add update check on launch.
- [ ] 🧑 **GOO-52D: Test signed build on clean macOS** — Verify Gatekeeper experience before sending to anyone.
- [ ] 🧑 **Create `pikos-app` GitHub org** — Transfer repo from personal account to `pikos-app/pikos`. Must happen before repo goes public (all marketing links point to `github.com/pikos-app/pikos`).
- [ ] 🧑 **Make repo public** — Flip to public after squashing into initial release commit + adding license. Must happen before `/download` page works (GitHub Releases 404 on private repos).
- [ ] 🤖 **GOO-53-DL: Cloudflare Pages Function for /download** — `/download/mac` and `/download/linux` redirect to latest GitHub Release assets. Requires public repo.
- [ ] 🤖 **Custom 404 page** — Branded 404 with links to `/`.

## Performance

### Performance scaling tasks

- [ ] Virtualize page/folder lists with `react-virtual` (TanStack Virtual) — required once a folder has 100+ pages. Without it, DOM node count scales linearly and folder switch slows down.

---

## Perf test upgrades (future)

Current perf tests (`e2e/perf.spec.ts`, `perf.prod.spec.ts`, `scripts/check-bundle-size.sh`) only cover the JS layer — React rendering, bundle size, long tasks. They run against Vite (dev or preview), not the Tauri webview. MockStorageAdapter is in the loop, not real SQLite.

**Not covered:**
- SQLite query latency (need Rust-side benchmarks, e.g. criterion)
- Tauri IPC overhead (invoke round-trip)
- WebView cold start (need tauri-driver + WebdriverIO)
- Real I/O paths
- **Realistic data volume testing**: seed a DB with 10000+ pages, 5000+ schedules, deep folder trees, large note bodies — simulate a year of heavy usage. Measure page list load, search, calendar render, and folder switch against real SQLite with realistic indexes and FTS. Could use the existing `pnpm seed` script as a starting point, run Tauri in dev mode, and profile with Playwright or manually.