# Pikos — Active Backlog

Working queue from Phase 2 through Public Launch. Ordered by the sequence things need to ship.
For post-launch specs — grep `BACKLOG.md` by GOO number.

Status: `[ ]` pending · Delete task when done.

---

## Phase 2A — Core Editor & Metadata

### Enhancements

- [ ] **GOO-108** Tab key behavior in editor _(High)_
  Tab/Shift+Tab intercepted — no longer moves browser focus. Lists: indent/outdent ✓. Task items: indent/outdent ✓. Code blocks: insert/remove 2 spaces ✓. **Remaining:** Tab in normal paragraphs should insert/remove indentation (insertText with spaces not working in paragraph nodes — needs investigation).

## 🚀 Friends Beta Gate

refinement (to fix)
- [ ] refine tutorial content
  - [ ] when deleting folder, delete pages or move to inbox? would make tutorial cleaner. Folder delete should probably be destructive, and it has a conformation dialog. All pages are soft deleted so we can recover when we add archive.
  - [ ] keyboard shortcuts for non mac? maybe not worth it
- [ ] tab and focus styling behavior, tab group and focus trap components?
- [ ] compact pageblock children rendering
- [ ] Misc dogfooding improvements.
- [ ] selecting in editor focuses to last character
- [ ] test auto updater
- [ ] complete shortcut (c, space/enter - which?)

to test
- multi page select


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