# Pikos — Active Backlog (Pre-Launch)

Status: `[ ]` pending · 🧑 manual · 🤖 agent · 🧑🤖 mixed. Delete when done.

---

## Refinement

- [ ] Refine tutorial content (recommended flow, new features, keyboard shortcuts for non-mac, recurring schedule, notification settings)
- [ ] Compact page block children rendering
- [ ] Double check multi day page blocks
- [ ] Multi-select drag doesn't reorder all selected (drop to calendar, delete, move to folder work)
- [ ] Misc dogfooding improvements
- [ ] "This week" smart view?
- [ ] Reorganize settings now that it has so much going on? Anything else to add for "fun" that would delight?
- [ ] Expected Slow - Deep dive into style refinement - expect a lot of LLM back and forth and manual refinements.
- [ ] Expected Slow - Tab and focus styling behavior, tab group and focus trap components

## QA

- [ ] DnD with virtualization (drag from long list to folder/calendar, scroll during drag)
- [ ] Completed section in virtual list (open/close accordion, "Show more" pagination)
- [ ] Edge cases (rapid folder switch, create page while scrolled, delete active page while scrolled)
- [ ] Folder list (reorder with drag, inline rename positioning)
- [ ] Test auto updater

## Import Follow-ups

- [ ] Blog post: import compatibility guide (what transfers, what doesn't, per-source workflow)
- [ ] Apple Notes/Reminders import guide (third-party tool recommendations)
- [ ] Character caps audit (page list, title, calendar popover, importer preview truncation)
- [ ] Stress test importer (1000+ files, 5000+ rows, special chars, malformed frontmatter)
- [ ] Folder name normalization option (as-is / lowercase / Title Case)
- [ ] Collapse nested folder prefixes option
- [ ] Undo toast in main app (currently only via Settings > General banner)

## Distribution & Public Launch

- [ ] 🧑 Register bundle identifier + generate signing certs (blocked on Apple Developer approval)
- [ ] 🧑🤖 GOO-52A: Wire up Apple signing in release workflow (blocked on certs)
- [ ] 🤖 GOO-52B: Tauri auto-updater (keypair, plugin config, update check on launch)
- [ ] 🧑 GOO-52D: Test signed build on clean macOS
- [ ] 🧑 Create `pikos-app` GitHub org, transfer repo
- [ ] 🧑 Make repo public (must happen before /download works)
- [ ] 🤖 GOO-53-DL: Cloudflare Pages Function for /download (redirect to latest GitHub Release)

### Notifications — Post-Launch

- [ ] OS notification action buttons (Mark Done) via `tauri-plugin-notification` action categories — requires platform-specific testing (macOS/Windows/Linux)
- [ ] Notification sound toggle — silent visual-only option, `.sound()` on notification builder

## Known Bugs

- [ ] Editor: typing "1." as first content causes text to disappear — WebKitInputRuleFix extension forces DOM repaint after node-type change
- [ ] Holding arrow key in large page list stops responding — rAF throttle on arrow key repeats in PageListPanel


## Recurring Schedule QA
Have claude evaluate current code against feature.md file. Fix any gaps, add/update test coverage.

Then manual QA:
  1. Calendar rendering
  - Create a recurring page ("standup every monday at 9am"), navigate to a week with Monday → virtual block appears on calendar
  - Virtual block shows recurring icon (arrows), NOT a checkbox
  - Head page's own calendar block shows a normal checkbox
  2. Completion flow (the big one)
  - Click checkbox on the head's calendar block → head advances to next Monday, clone appears in completed section
  - Click checkbox in page list → same behavior
  - Click checkbox in page view → date chip updates to next occurrence
  - After completing, the head stays in the page list as "not_started" with the new date
  - Complete 2-3 times → verify head ID stays stable (same page in editor), multiple clones in completed
  3. Virtual occurrence popover
  - Single-click a virtual block → read-only popover appears (title, folder, date, priority, recurrence cadence)
  - "Open page" in popover → opens the head page in editor
  - "Skip this occurrence" (trash icon) → virtual block disappears immediately
  - After skip, navigating away and back → skipped occurrence stays gone
  4. Edge cases
  - Create recurring page with no time ("run every friday") → all-day virtual blocks appear in the all-day section
  - Overdue recurring page (head scheduledStart is in the past) → shows in Today view
  - Completing overdue recurring page → advances to next future occurrence, not the one after the overdue date
  - Delete the head page → all virtual occurrences disappear from calendar
  5. NLP input variations (spot check)
  - "standup mondays at 9am" → recurring (plural day name)
  - "gym every tue and thu at 6pm" → recurring with two days
  - "report every month" → recurring monthly
  - "standup monday at 9am" (no "every") → single, NOT recurring

  Items 1-3 are the critical paths. Items 4-5 are lower risk since they're well covered by unit tests but worth a quick spot check.