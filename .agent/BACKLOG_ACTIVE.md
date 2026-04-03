# Pikos — Active Backlog

Working queue from Phase 2 through Public Launch. Ordered by the sequence things need to ship.
For post-launch specs — grep `BACKLOG.md` by GOO number.

Status: `[ ]` pending · Delete task when done.

---

## Refinement (to fix)
- [ ] refine tutorial content (recommended flow / new features? / keyboard shortcuts for non mac? maybe not worth it)
- [ ] tab and focus styling behavior, tab group and focus trap components?
- [ ] compact pageblock children rendering
- [ ] test auto updater
- [ ] multi select drag doesn't reorder all selected, it does drop all on calendar, delete all, move all to folder.
- [ ] Misc dogfooding improvements.
- [ ] "This week" feature in Pikos? 

## To test
  DnD with virtualization
  - Drag a page from the middle of a long list to a folder in the sidebar — should work, no ghost items
  - Drag a page to the calendar while scrolled partway down the list
  - Drag a page, scroll during the drag (if possible) — items entering the viewport should render correctly
  Completed section in virtual list
  - Open completed accordion, scroll down through completed pages, then close it — scroll position shouldn't jump wildly
  - Open completed, click "Show more" a few times — new items should appear below existing ones without layout jumps      
                                               
  Edge cases                 
  - Switch rapidly between folders (one with 150+ pages, one with 3) — list should resize instantly, no stale items from the previous
  - Create a new page while scrolled to the bottom of a long list — should it appear and scroll into view?
  - Delete the active page while scrolled deep — list should adjust without blank gaps

  Folder list specifically          
  - With your 20 folders, try reordering via drag — verify the insertion line still appears in the right spot                         
  - Rename a folder inline — the input should appear correctly positioned, not offset

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


---

## Perf test upgrades (future)

Current perf tests (`e2e/perf.spec.ts`, `perf.prod.spec.ts`, `scripts/check-bundle-size.sh`) only cover the JS layer — React rendering, bundle size, long tasks. They run against Vite (dev or preview), not the Tauri webview. MockStorageAdapter is in the loop, not real SQLite.

**Not covered:**
- SQLite query latency (need Rust-side benchmarks, e.g. criterion)
- Tauri IPC overhead (invoke round-trip)
- WebView cold start (need tauri-driver + WebdriverIO)
- Real I/O paths
- **Realistic data volume testing**: seed a DB with 10000+ pages, 5000+ schedules, deep folder trees, large note bodies — simulate a year of heavy usage. Measure page list load, search, calendar render, and folder switch against real SQLite with realistic indexes and FTS. Could use the existing `pnpm seed` script as a starting point, run Tauri in dev mode, and profile with Playwright or manually.