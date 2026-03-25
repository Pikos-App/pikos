# Pikos — Active Backlog

Working queue from Phase 2 through Public Launch. Ordered by the sequence things need to ship.
For post-launch specs — grep `BACKLOG.md` by GOO number.

Status: `[ ]` pending · Delete task when done.

---

## Phase 2A — Core Editor & Metadata

### Enhancements

- [ ] **GOO-108** Tab key behavior in editor _(High)_
  Tab/Shift+Tab intercepted — no longer moves browser focus. Lists: indent/outdent ✓. Task items: indent/outdent ✓. Code blocks: insert/remove 2 spaces ✓. **Remaining:** Tab in normal paragraphs should insert/remove indentation (insertText with spaces not working in paragraph nodes — needs investigation).


- [ ] **GOO-113** Editor accessibility _(High)_
  The editor needs WCAG 2.1 AA compliance per project standards. Currently missing: `role="textbox"` and `aria-label` on the editor container, `aria-live` region for save state announcements, visible focus indicator on the editor container, keyboard-accessible task list checkboxes, placeholder text announced to screen readers (currently CSS-only). Should be done alongside or right after GOO-106 (keyboard scope).
  **Note (from GOO-111):** Add `tabIndex={-1}` to the root `<div>` in `PageListItem.tsx` so that after Escape blurs the editor, the active page list item is properly focusable and receives visual focus. Currently the div is not natively focusable so `el.focus()` silently no-ops.

## 🔍 Search & Commands — Minimum Quality Bar

_Without these the app feels half-finished to any organic user. Ship before public launch._

- [ ] **GOO-17** Command palette _(High — public launch blocker)_
  `Cmd+P` → fuzzy page title search. `Cmd+P` twice (chord) → content search mode. `Cmd+K` → actions (new page, switch workspace, settings). Recent pages section.
  Title search: client-side fuzzy via `fuse.js` against `pages[]` in WorkspaceContext (immediate, no DB round-trip). Content search: FTS5 via `search_pages` Tauri command (debounced). See `features/search.md`. It seems like this could use some more thought though — maybe we want server-side search, then we can return the data that's needed to navigate to the folder/page? This should be insanely fast regardless of how many pages/folders there are. Content search should also be ripping fast and top tier — highlight matching words/partial.

- [ ] **GOO-18** FTS5 content search _(High — public launch blocker)_
  FTS5 virtual table on `pages.content` + `pages.title` + `pages.tags`. Tauri command `search_pages(query)`. Updates on save. Highlighted excerpt snippets via FTS5 `snippet()`.

- [ ] Simple undo option when deleting something (via animated toast that comes in / goes out after ~5 seconds). Should not animate out if the mouse is on the toast.

## 📅 Calendar Feature

_GOO-21b complete: state model, editor/calendar toggle, click-to-create, popover, status checkbox, drag-to-reschedule, resize, drag-to/from all-day._

---

## 🚀 Friends Beta Gate

_Must ship before sharing with anyone outside the team. External blocker: Apple Developer account ($99/yr)._

- [ ] **GOO-51** App branding _(Medium — friends beta blocker)_
  Icon, wordmark, color palette. Needed before any public presence. Tauri uses `apps/desktop/src-tauri/icons/` — multiple sizes required (32×32 to 512×512 + `.icns` for macOS).

- [ ] **GOO-52** Cross-platform builds + signing + GitHub Releases pipeline _(High — friends beta blocker)_
  `release.yml` triggered on `git tag v*`. Matrix: macOS (notarized via Apple Developer Program, `tauri-apps/tauri-action`), Windows (SmartScreen warning OK for Phase 2 beta), Linux (AppImage + deb, no signing needed).
  **One-time setup:** Apple Developer account → Developer ID cert → notarization credentials as GitHub secrets. `tauri-apps/tauri-action` automates sign + notarize on every tagged release. Budget ~2–3 hrs for first-time setup.

- [ ] **GOO-50** Auto-updater _(Medium — friends beta blocker)_
  `tauri-plugin-updater`. Check on launch → non-blocking banner ("Version X.X available — restart to update") → download + install + relaunch. Update server: GitHub Releases. Wire in before any external release.

---

## 🌐 Public Launch Gate (Phase 3)

_Required before the marketing site goes live and the download button appears._

- [ ] **GOO-53** Marketing site Phase 3 _(Medium — public launch blocker)_
  Phase 2.5 ✓ (landing page + email capture form live at pikos.app). Remaining for Phase 3:
  `/open` (open metrics), `/download` (release links), `/changelog`. See `features/marketing-site.md`.

- [ ] **GOO-116** Email capture backend integration _(High — public launch blocker)_
  The email form on the landing page is UI-only. Wire it to an email service so captured addresses are stored and can be emailed on launch.
  - Pick provider: Resend Audiences, Loops, or ConvertKit (all have free tiers; Loops is nicest for simple launch lists)
  - Add a serverless handler or use the provider's form endpoint directly (no server needed if using a hosted form endpoint)
  - On submit: POST to provider API → return success/error to UI → show confirmation state ("You're on the list!")
  - Double-opt-in not required for a launch waitlist
  - Store API key as env var in hosting platform (not in repo)

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