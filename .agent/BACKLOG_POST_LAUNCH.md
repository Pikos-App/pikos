# Pikos — Post-Launch Backlog

Items for after public launch. Ordered roughly by priority within each section.

---

## V1 Polish (first months post-launch)

- [ ] **GOO-38** Page list filters (status, scheduled, priority, tag multi-select)
- [ ] **GOO-81** Split view (2 editor panes, L/R or T/B, Cmd+Shift+\\)
- [ ] **GOO-24** Refine native menu bar (basic menu shipped — audit for missing items, accelerators, edge cases)
- [ ] **GOO-62** App-level undo/redo (full CommandHistory stack — delete undo via toast works today)
- [ ] **GOO-99** Enhanced folder delete modal (move pages vs archive pages)
- [ ] **GOO-105** Editor drag handle (block reorder via grip icon)
- [ ] **GOO-61** Quick Add smart recommendations (history-based ghost text)
- [ ] **GOO-78** Focus Timer panel (sidebar timer, session log, auto-discard <10s)
- [ ] **GOO-95** Dev: seed command to reset UI preferences

## Navigation & Organization

- [ ] **GOO-13** Wikilink autocomplete + backlinks panel
- [ ] **GOO-12** Page parent/child relationships (max 3 levels nesting)
- [ ] **GOO-98** Nested folders (off by default, enable in settings)
- [ ] Tags panel in sidebar + tag views + tag filtering
- [ ] `#tag` syntax in editor body → sync to tags column

## Calendar Depth

- [ ] Day view
- [ ] Recurring event creation/editing UI
- [ ] Recurring exception handling UI (skip/override single occurrences)
- [ ] Calendar filter by tag/folder
- [ ] **GOO-22** CalDAV external calendar sync (read-only)
- [ ] **GOO-64** Timezone-aware scheduling + DST handling
- [ ] **GOO-66** Write Pikos pages to external CalDAV calendar

## Search & Command Palette

- [ ] Cmd+P title search (fuzzy, fuse.js, in-memory)
- [ ] Cmd+P double-tap → content search
- [ ] Actions palette in Cmd+K

## Import/Export

- [ ] **GOO-74** Extended export formats (CSV, HTML, ICS/iCal)
- [ ] **GOO-75** Third-party app import (Things 3, Evernote, OPML)

## Performance & Observability

- [ ] **GOO-55** Local performance monitor (budgets, overlay UI, stress test mode)
- [ ] **GOO-58** Network activity monitor (transparent log of outbound requests)
- [ ] Observability: download tracking (privacy-respecting)

## Mac App Store (Phase 4)

- [ ] Sandbox compatibility audit + migration path
- [ ] App Sandbox entitlements
- [ ] MAS signing certificates + CI build target
- [ ] App Store metadata + privacy declarations
- [ ] Submit + handle review ($19.99 one-time)

## Marketing Site

See `features/marketing-site.md`.
- [ ] Phase 3: full multi-page site (/open, /privacy, /download, /changelog)
- [ ] Help content, feedback collection, comparison page
- [ ] AEO optimization

## Platform & Ecosystem (far future)

- Sync (ElectricSQL/PowerSync/cr-sqlite — not until paying customers)
- Mobile (React Native — after desktop is solid)
- Plugin system + AI agent (post Phase 4)
- i18n/localization foundation
- Page sharing (read-only public links)
- Public REST API, automation integrations
- Messaging bots (Telegram, Discord)
- Collaboration (shared workspaces, CRDT)

## Notes & Ideas

- Habit tracking via rrule + completion rate visuals
- Password protection / biometric access
- Priority smart view (conditionally render if any items have priority)
- Page location field (like Google Calendar)
- Settings to disable status system (pure note-taking mode)
- Priority coloring in page list (colored checkboxes or dots, default off)
- AI/conversational mode — local LLM for schedule queries, reflection
- Accessibility: focus ring consistency, escape to exit editor, tab navigation
- Editor: search occurrence highlighting in scrollbar, word/character count, context menu, bubble menu keyboard nav
- Settings: hide weekends, configurable metadata fields, sync with Reminders
