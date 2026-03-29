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

_Must ship before sharing with anyone outside the team. External blocker: Apple Developer account ($99/yr)._

styling refinement
- tab and focus styling behavior, tab group and focus trap components?
- compact pageblock children rendering

- [ ] First-time user content / tutorial — approach TBD. Options: pre-seeded sample pages (like Obsidian), interactive walkthrough (tooltips/coachmarks), or a short guided flow post-welcome screen. Needs to teach: create a page, schedule it, use the calendar, organize with folders. Should be dismissable and not block power users.

- [ ] **GOO-52** Cross-platform builds + signing + GitHub Releases pipeline _(High — friends beta blocker)_
  `release.yml` triggered on `git tag v*`. Matrix: macOS (notarized via Apple Developer Program, `tauri-apps/tauri-action`), Windows (SmartScreen warning OK for Phase 2 beta), Linux (AppImage + deb, no signing needed).
  **One-time setup:** Apple Developer account → Developer ID cert → notarization credentials as GitHub secrets. `tauri-apps/tauri-action` automates sign + notarize on every tagged release. Budget ~2–3 hrs for first-time setup.

- [ ] **GOO-50** Auto-updater _(Medium — friends beta blocker)_
  `tauri-plugin-updater`. Check on launch → non-blocking banner ("Version X.X available — restart to update") → download + install + relaunch. Update server: GitHub Releases. Wire in before any external release.

- [ ] Misc dogfooding improvements.

### Performance scaling tasks

- [ ] Lazy load completed records — don't fetch completed pages until the "Completed" section is expanded. Keeps initial query fast as completed count grows over months. Only fetch 20 completed at a time, with conditional load more button below completed records.
- [ ] Virtualize page/folder lists with `react-virtual` (TanStack Virtual) — required once a folder has 100+ pages. Without it, DOM node count scales linearly and folder switch slows down.

---

## 🌐 Public Launch Gate (Phase 3)

_Required before the marketing site goes live and the download button appears._

- [ ] **GOO-53** Marketing site Phase 3 _(Medium — public launch blocker)_
  Phase 2.5 ✓ (landing page + email capture form live at pikos.app). Remaining for Phase 3:
  `/open` (open metrics), `/download` (release links), `/changelog`. See `features/marketing-site.md`.

- [ ] **GOO-117** Marketing site analytics _(Medium — public launch blocker)_
  Lightweight, privacy-first page view tracking. No cookies, no fingerprinting — consistent with the product promise.
  - Recommended: Plausible (self-hosted or $9/mo cloud) or Fathom. Both are GDPR-compliant out of the box.
  - Alternative: roll a minimal hit counter using a Cloudflare Worker + KV (free tier, zero third-party) — fits the local-first brand story.
  - Add the script tag to the Astro layout so all pages are tracked automatically.
  - Verify no PII is collected and document the provider choice in `features/marketing-site.md`.

- [ ] **GOO-118** About page on marketing site _(Low — public launch blocker)_
  Short `/about` page: who built it and why, the local-first philosophy, contact/feedback link.
  - One page, no photos required — words carry it.
  - Link from footer next to Privacy.

- [ ] **GOO-54** Privacy policy on marketing site _(Low — public launch blocker)_
  Plain language, one page at `/privacy`. Cover: what stays on device (everything), what leaves only with opt-in (email address you typed in), what is never collected (note content), how to export data. Link from footer.


_For post-launch V1, power features, and long-term roadmap — grep `BACKLOG.md` by GOO number._

---

## Perf test upgrades (future)

Current perf tests (`e2e/perf.spec.ts`, `perf.prod.spec.ts`, `scripts/check-bundle-size.sh`) only cover the JS layer — React rendering, bundle size, long tasks. They run against Vite (dev or preview), not the Tauri webview. MockStorageAdapter is in the loop, not real SQLite.

**Not covered:**
- SQLite query latency (need Rust-side benchmarks, e.g. criterion)
- Tauri IPC overhead (invoke round-trip)
- WebView cold start (need tauri-driver + WebdriverIO)
- Real I/O paths
- **Realistic data volume testing**: seed a DB with 10000+ pages, 5000+ schedules, deep folder trees, large note bodies — simulate a year of heavy usage. Measure page list load, search, calendar render, and folder switch against real SQLite with realistic indexes and FTS. Could use the existing `pnpm seed` script as a starting point, run Tauri in dev mode, and profile with Playwright or manually.