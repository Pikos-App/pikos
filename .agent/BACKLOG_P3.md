# Pikos — Phase 3+ Power Features & Long-Term Roadmap

Items for after V1 post-launch polish is stable. Power features, ecosystem integrations, and future platform work.

Status: `[ ]` pending · `[-]` superseded/deferred/do not start

---

## Power Features

- [ ] **GOO-12** Page parent/child relationships _(Medium)_
  `parentId` stored as DB column (already in schema). Max 3 levels of nesting. Children shown as indented list below parent in pages panel.
  **Open question**: when a parent page is marked `done`, should children auto-complete? Leaning yes (with undo toast) — common in task managers. Decide before implementing status toggle (GOO-33).

- [ ] **GOO-13** `[[wikilink]]` syntax + backlinks _(Medium)_
  Typing `[[` → autocomplete popup with matching page titles. Click wikilink → navigate to page. Backlinks panel shows inbound links. Extracted links stored in `page.links[]` JSON column.

- [ ] **GOO-58** Network activity monitor _(Medium)_
  Transparent log of every outbound request (CalDAV, AI, plugins, updater). Rust `NetworkLogger` wrapping all `reqwest` calls — logs host, bytes, status, duration. Never logs full URLs, bodies, or credentials.

  **UI**: pulsing dot in status bar during activity → opens log panel. Full view in Settings > Privacy > Network Activity.

- [ ] **GOO-66** Write Pikos pages to external CalDAV calendar _(Medium)_ — **requires GOO-22**
  Pages with `scheduled_start` pushed to user's designated CalDAV calendar as VEVENTs. iCal UID = Pikos page UUID. Creating/updating/completing/deleting a page syncs the event. No two-way conflict resolution in v1 — Pikos is always source of truth for events it created.

- [ ] **GOO-68** Page sharing — read-only public links _(Medium)_
  "Share page" → upload rendered HTML to Pikos sharing service → short URL. "Unshare" revokes + deletes server copy. Shared pages are static at time of sharing. Requires server infra (Cloudflare Worker + R2). Dependencies: GOO-52 (shipping), GOO-65 (per-page export).

- [ ] **GOO-67** i18n / localization foundation _(Low)_
  `react-i18next` + `i18next`. All user-visible strings behind `t('key')`. Source locale: `en`. Locale files: `packages/core/src/locales/`. NL parser (GOO-19) stays English-only for v1 — Settings note: "Natural language input is English-only for now."

- [ ] GOO-59 (Settings infrastructure) — this is sitting in P2 but you're already making decisions that need a settings surface (hide completed toggle, sort preferences, spell check, theme). Without a settings panel, these preferences have nowhere to live. I'd pull this into Active and do a minimal version: just General + Appearance + Editor panels. The Workspaces, Calendars, and plugin-related panels can stay stubbed or deferred.
- [ ] GOO-24 (Native menu bar) — also in P2, but shipping a Mac app to friends without a proper menu bar will feel immediately unfinished. Cmd+W, Cmd+Q, standard Edit menu, basic View toggles. This is table stakes for a native Mac app and your target audience will notice.
- [ ] GOO-49 (Export to Markdown) — friends beta users will ask "how do I get my stuff out?" on day one. Having export before anyone puts real data in builds trust, especially with the "your data, your device" promise. Import can wait, export can't.

---

## Design Decisions (not yet ticketed)

- [ ] **GOO-98** Nested folders _(Low)_
  **Decision needed before implementing.** Options:
  - **Flat only (v1)**: simplest, avoids tree complexity in sidebar + queries. Folders = namespaces.
  - **Nested (advanced setting, off by default)**: sidebar becomes a tree, `parent_folder_id` column needed (not in current schema). Max depth TBD (2–3 levels recommended).
  Leaning: **off by default, enable in Settings > General**. If nested is enabled, folder picker (GOO-94 Move to folder) becomes a tree picker. FTS and page list queries unaffected (filter by `folder_id` only — no recursive walk needed for listing). Schema: add `parent_folder_id TEXT REFERENCES folders(id)` migration.

---

## Monetization Infrastructure

- [ ] **GOO-52-MAS** Mac App Store submission _(High — Phase 4)_
  After Phase 3 public launch proves stability. Sandboxing audit, entitlements review, App Store Connect submission, review process. Primary non-technical discovery channel. $19.99 one-time purchase. See `GTM.md` for pricing rationale.

---

## Sync (do not start until paying customers exist)

- [-] **GOO-25** Cross-platform sync — not until shipped to real users. Options: ElectricSQL, PowerSync, cr-sqlite. When implementing: re-evaluate TanStack Query as async state layer.

---

## Mobile (after desktop is solid)

- [-] **GOO-47** Mobile: React Native — after desktop V1 is stable. Create 3 divergent mobile UI variants for review before any migration. `packages/core` pure-TS layer was designed for this from day one.
- [-] **GOO-71** Mobile: Home Screen widget — after GOO-47. iOS WidgetKit, Android Glance.
- [-] **GOO-72** Mobile: Siri / system reminders integration — after GOO-47. `INAddTasksIntent` (iOS), Google Assistant intents (Android).

---

## Platform & Ecosystem (far future)

- [-] **GOO-46** Telemetry: PostHog + Sentry — not until real users. Two separate opt-ins, both off by default.
- [-] **GOO-56** Plugin system foundation — post Phase 4. See `features/extensibility.md`.
- [-] **GOO-57** AI agent / personal assistant — post GOO-56. See `features/extensibility.md`.
- [-] **GOO-63** Conversational / voice mode — post GOO-57. whisper.cpp sidecar + AVSpeechSynthesizer.
- [-] **GOO-69** Public REST API (CRUD) — requires server infra, after GOO-25 (sync).
- [-] **GOO-70** Automation integrations — webhooks, n8n, Zapier — after GOO-69.
- [-] **GOO-73** Collaboration — shared workspaces — far future, requires server + CRDT (cr-sqlite).
- [-] **GOO-82** Messaging bot platform (shared foundation) — post GOO-57.
- [-] **GOO-83** Telegram bot — post GOO-82.
- [-] **GOO-84** Discord bot — post GOO-82.
- [-] **GOO-85** WhatsApp / Signal integration — post GOO-84, approach TBD.
- [-] **GOO-86** Proactive notifications via messaging — post GOO-83.
- [-] **GOO-99** Settings toggle to disable the status system _(Low)_
  Settings > General > "Use status & tasks" toggle. When off, the status checkbox+label is hidden from the metadata byline and page list items, and smart views (Today/Inbox) still function but without status-based filtering. Intended for pure note-taking users who find task UI noisy.
- [-] **GOO-6** Component library repo — absorbed into `packages/ui` in monorepo.
- [-] **GOO-42** First-run + onboarding — superseded by GOO-15 (auto-creates workspace at appDataDir).

## misc backlog notes - to be sorted.
- [-] Add settings for priority - allow users to turn on priority coloring in the page item list (either colored checkboxes or colored dot next to the date). Default off in the list. Already implemented: show in the page / allow to sort list by priority


What does the future of pikos look like? AI first / conversational integrated with our personal devices. Could ask Pikos questions. Am I free Wednesday at 3pm? Am I free Wednesday evening? How many times have I ran over the last 3 months. Useful for reflection. Useful for managing schedule and thoughts. Maybe non llm check. Maybe light local llm. 