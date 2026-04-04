# Pikos — Active Backlog (Pre-Launch)

Status: `[ ]` pending · 🧑 manual · 🤖 agent · 🧑🤖 mixed. Delete when done.

---

## Refinement

- [ ] Refine tutorial content (recommended flow, new features, keyboard shortcuts for non-mac)
- [ ] Tab and focus styling behavior, tab group and focus trap components
- [ ] Compact page block children rendering
- [ ] Double check multi day page blocks
- [ ] Test auto updater
- [ ] Multi-select drag doesn't reorder all selected (drop to calendar, delete, move to folder work)
- [ ] Misc dogfooding improvements
- [ ] "This week" smart view?

## QA

- [ ] DnD with virtualization (drag from long list to folder/calendar, scroll during drag)
- [ ] Completed section in virtual list (open/close accordion, "Show more" pagination)
- [ ] Edge cases (rapid folder switch, create page while scrolled, delete active page while scrolled)
- [ ] Folder list (reorder with drag, inline rename positioning)

## Import Follow-ups

- [ ] Blog post: import compatibility guide (what transfers, what doesn't, per-source workflow)
- [ ] Apple Notes/Reminders import guide (third-party tool recommendations)
- [ ] Character caps audit (page list, title, calendar popover, importer preview truncation)
- [ ] Stress test importer (1000+ files, 5000+ rows, special chars, malformed frontmatter)
- [ ] Folder name normalization option (as-is / lowercase / Title Case)
- [ ] Collapse nested folder prefixes option
- [ ] Undo toast in main app (currently only via Settings > General banner)
- [ ] RRULE mapping (after recurring events land) — TickTick `Repeat` column
- [ ] Notification/reminder mapping (after notifications land) — TickTick `Reminder` column

## Distribution & Public Launch

- [ ] 🧑 Enroll in Apple Developer Program ($99/yr) — gating dependency. See BACKLOG_DISTRIBUTION.md.
- [ ] 🧑 Register bundle identifier (`app.pikos.desktop`) in Apple Developer portal
- [ ] 🧑 Generate macOS code signing certificates (Developer ID Application)
- [ ] 🤖 Audit bundle identifier in tauri.conf.json
- [ ] 🧑🤖 GOO-52A: GitHub Actions release workflow (signed, notarized macOS builds on tag push)
- [ ] 🤖 GOO-52B: Tauri auto-updater (keypair, plugin config, update check on launch)
- [ ] 🧑 GOO-52D: Test signed build on clean macOS
- [ ] 🧑 Create `pikos-app` GitHub org, transfer repo
- [ ] 🧑 Make repo public (must happen before /download works)
- [ ] 🤖 GOO-53-DL: Cloudflare Pages Function for /download (redirect to latest GitHub Release)

## Recurring Events & Notifications

- [ ] **GOO-60** Recurring event creation/editing UI (backend + NLP + calendar expansion done, needs UI)
- [ ] **GOO-87** Notification system — see `features/notifications.md` for full design
  - Rust Tokio background scheduler (immune to JS timer throttling)
  - Pre-event reminders (configurable per-page), overdue alerts
  - OS notifications (macOS Notification Center) + in-app banners when focused
  - New DB tables: `page_reminders`, `notification_log`
  - Settings panel for defaults, quiet hours, digest

## Known Bugs

- [ ] Editor: typing "1." as first content causes text to disappear until next keystroke (WebKit contenteditable vs ProseMirror)
- [ ] Holding arrow key in large page list eventually stops responding (rapid key repeat saturates React re-renders)
