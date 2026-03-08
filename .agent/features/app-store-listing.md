# Mac App Store Listing — Pikos

App Store Connect · macOS · $19.99 one-time purchase

Reference: [App Store product page guidelines](https://developer.apple.com/app-store/product-page/)

---

## App metadata

### App name
```
Pikos
```
Max 30 characters. Keep it exactly "Pikos" — no subtitle baked in. The subtitle field handles positioning.

### Subtitle
```
Notes, Tasks & Calendar
```
Max 30 characters. Appears below the name in search results and on the product page. This is the second-most-read piece of text after the name — it needs to communicate the three pillars instantly.

Alternative options (all under 30 chars):
- `Your notes, tasks & calendar`  (29 chars)
- `Notes · Tasks · Calendar`      (25 chars — cleaner, less conventional)

### Category
- **Primary:** Productivity
- **Secondary:** Utilities

### Price
- **$19.99** (Tier 20)
- Purchase type: One-time (not subscription)

---

## Description

**First 3 lines are critical.** App Store truncates after ~255 characters before "more". On iPhone/iPad these lines are what the user reads without tapping "more". On Mac the threshold is similar.

```
Pikos brings your notes, tasks, and calendar into one fast, private Mac app.
Everything stays on your device — no account, no subscription, no cloud required.

Write notes. Manage tasks. Schedule your week. All in one place, all offline by default.

────────────────

YOUR NOTES, YOUR TASKS, YOUR CALENDAR — UNIFIED

Most people use three apps to do what Pikos does in one: a notes app, a task manager, and a calendar. Pikos combines all three without compromise.

Every page is simultaneously a note and a task. Write freely, then assign a date, a priority, and a status. Drag it onto your calendar. See your week in context.

────────────────

PRIVATE BY DEFAULT

Pikos stores everything in a local database on your Mac. We have no servers, no accounts, and no telemetry. Your notes never leave your device unless you choose to sync them.

Optional iCloud sync lets you access your notes across your Apple devices — using Apple's infrastructure, not ours.

────────────────

BUY ONCE, OWN FOREVER

No subscription. $19.99 gets you the full app and every future update. iCloud sync is included at no extra charge. There's nothing to unlock.

────────────────

FEATURES

• Rich text editor — write notes the way you think, with headings, tasks, code blocks, and images
• Task management — status, priority, due dates, and scheduling built into every page
• Week calendar — drag pages onto any day to schedule them; see everything in context
• Smart views — Today shows everything due now; Inbox holds unscheduled pages
• Full-text search — instant, local, finds anything
• iCloud sync — optional, automatic, no account required
• Focus timer — built-in Pomodoro-style timer, no third-party app needed
• Keyboard-first — navigate entirely without touching the mouse
• Dark mode — fully supported, follows system preference
• Import — bring in notes from Markdown files

────────────────

WHAT PEOPLE ARE REPLACING

If you use two or more of these, Pikos might replace all of them:
→ Obsidian (notes only, no real task management)
→ TickTick or Todoist (tasks only, no rich notes)
→ Notion (cloud-first, slow, requires an account)
→ NotePlan (similar idea, Markdown files, weaker calendar)

────────────────

SYSTEM REQUIREMENTS

macOS 13 Ventura or later. Apple Silicon and Intel supported.

────────────────

PRIVACY

Pikos collects no data. No analytics, no crash reporting sent to us, no usage tracking. The app runs entirely on your device. Full privacy policy at pikos.app/privacy.
```

**Character count guidance:**
- Full description limit: 4000 characters
- Above draft is approximately 2,400 characters — room to expand with more detail if needed

---

## Keywords

Max 100 characters total. Comma-separated, no spaces after commas. Do not repeat words already in the app name, subtitle, or category name.

```
private,local,offline,planner,journal,organizer,markdown,diary,agenda,focus,pomodoro,writing
```

**Keyword logic:**
- `private`, `local`, `offline` — captures privacy-conscious searches
- `planner`, `organizer`, `agenda` — captures the scheduling/calendar use case
- `journal`, `diary`, `writing` — captures the notes use case
- `markdown` — captures Obsidian/Bear migration searches
- `focus`, `pomodoro` — captures the built-in focus timer
- Avoid `notes`, `tasks`, `calendar` — already in the subtitle, Apple indexes those separately

**Research targets** (check App Store Search Ads Keyword Planner for volume):
- "notes app" — very high volume, very competitive
- "task manager" — high volume, competitive
- "planner app" — medium volume, less competitive
- "private notes" — medium volume, low competition
- "offline notes" — lower volume, very low competition

---

## Screenshots

Mac App Store allows up to 10 screenshots. Required size: **2880 × 1800px** (5K Retina).

Apple also accepts **1280 × 800** and **1440 × 900**. Submit at 2880 × 1800 for highest quality.

### Screenshot sequence (order matters — first 3 visible without scrolling)

#### Screenshot 1 — Hero / Overview
**Caption:** `Your notes, tasks, and calendar. One app.`

Show the full three-panel layout: sidebar with pages list, editor with a real note open, calendar panel showing a week with scheduled items. Use realistic content — a mix of work and personal tasks. No Lorem Ipsum.

Design tip: Add a thin device frame (Mac window chrome) and a clean desktop background. Keep it light — the default light theme shows more contrast in thumbnails.

#### Screenshot 2 — Privacy story
**Caption:** `Everything on your device. No account required.`

Show the editor with a personal-looking note (meeting notes, journal entry, project plan). Overlay or caption text at the bottom of the image: "Stored locally. Private by default." Use the dark theme for contrast with screenshot 1.

#### Screenshot 3 — Tasks + Calendar
**Caption:** `Drag any note onto your calendar to schedule it.`

Show a note with task metadata visible (priority chip, due date, status) in the left panel, and the calendar panel showing that page as a block on the correct day. Capture the "notes and tasks are the same thing" insight.

#### Screenshot 4 — Today smart view
**Caption:** `Today shows everything that needs your attention.`

Show the Today view in the sidebar selected, with a filtered list of pages due today. Editor shows one of them open. Clean, not overwhelming.

#### Screenshot 5 — Focus timer
**Caption:** `Built-in focus timer. No extra app needed.`

Show the focus timer UI active — ideally mid-session, showing time remaining. A task is open in the editor behind it. Conveys that focus + notes + tasks are unified.

#### Screenshot 6 — Search
**Caption:** `Full-text search. Instant. Entirely offline.`

Show the search overlay open with a realistic query and results. Highlight that results appear instantly without a spinner.

#### Screenshot 7 — Dark mode
**Caption:** `Dark mode. Follows your system preference.`

Same layout as screenshot 1 but in dark mode. Shows the app looks polished in both themes.

#### Screenshot 8 — Keyboard navigation
**Caption:** `Built for the keyboard. Navigate without the mouse.`

Show the command palette or a keyboard shortcut hint overlay. Appeals to power users who scan screenshots for this.

### Screenshot production guidelines

- Use real content — realistic notes (meeting notes, project plan, journal entry, reading list). Nothing that looks staged.
- No marketing copy overlaid on screenshots unless it's a small bottom-bar caption. The app should speak for itself.
- Consistent window size across all screenshots. Crop consistently.
- If adding captions: white text, semi-transparent black pill background, bottom-center of the image. Keep it short (< 8 words).
- Generate at 2× or higher DPI — use a Retina Mac to capture.

---

## App Preview video (optional but recommended)

Max 30 seconds. No audio required (most users watch muted). Show:
1. Opening the app cold — instant, no loading screen (0–3s)
2. Creating a new page via Quick Add (Cmd+N) (3–10s)
3. Typing a note, adding a due date via NL input (10–18s)
4. Dragging it onto the calendar (18–24s)
5. Calendar view showing the scheduled block (24–28s)
6. End frame: app name + "Download on the Mac App Store" (28–30s)

Keep it real-time — no speed-up, no cuts. The "instant" feel is the product.

---

## App icon

Required sizes for Mac App Store submission:
- 1024 × 1024 px (App Store listing)
- 512 × 512, 256 × 256, 128 × 128, 64 × 64, 32 × 32, 16 × 16 (macOS bundle)

**Icon design principles:**
- Must look good at 16 × 16 (Dock, Finder sidebar) — test at actual size
- macOS icons use a rounded-rect shape (squircle) — Apple clips automatically; design to the edges
- Avoid text in the icon — unreadable at small sizes
- Should be immediately recognizable and distinct from competitors (Obsidian uses a crystal, Bear uses a bear, Notion uses N)
- Consider a simple, memorable mark — a calendar page with a checkmark, a note with a calendar, or an abstract mark unique to Pikos

---

## Pricing & availability

| Field | Value |
|-------|-------|
| Price tier | $19.99 (Tier 20) |
| In-app purchases | None at launch |
| Free trial | Not applicable (one-time purchase, no subscriptions) |
| Family Sharing | Enable — one purchase covers the whole family, at no cost to you |
| Availability | All territories (adjust if needed for compliance) |
| Release date | Manual release (don't auto-release — review the listing before it goes live) |

**Note on Family Sharing:** Enabling it costs you nothing for a one-time purchase app (you've already been paid). It's a meaningful trust signal for non-technical buyers.

---

## App Store Connect — technical requirements

### Sandboxing
The Mac App Store requires App Sandbox. Verify the Tauri app has these entitlements:
- `com.apple.security.app-sandbox` = true
- `com.apple.security.files.user-selected.read-write` (for workspace file access)
- `com.apple.security.network.client` (for iCloud sync, if applicable)

### iCloud entitlement
For iCloud sync (Phase 4a):
- `com.apple.developer.icloud-container-identifiers`
- `com.apple.developer.ubiquity-kvstore-identifier`

These require an explicit capability in App Store Connect and the provisioning profile.

### Age rating
Complete the age rating questionnaire. Pikos has:
- No user-generated content shared publicly
- No in-app purchases
- No location tracking
- No advertising

Expected rating: **4+**

### Privacy nutrition label (required)
App Store Connect requires a privacy nutrition label. For Pikos at launch:

| Data type | Collected | Linked to identity | Used for tracking |
|-----------|-----------|-------------------|-------------------|
| All categories | No | — | — |

Select "No data collected." This is a genuine competitive advantage — be accurate.

---

## Review notes (for App Store review team)

Include in the "Notes for App Review" field in App Store Connect:

```
Pikos is a local-first productivity app for Mac. All data is stored on the
user's device in a SQLite database. No account or network connection is
required to use the app.

The app uses SQLite for local storage and the file system for workspace
management. No external network calls are made during normal operation.

iCloud sync is optional and uses Apple's native CloudKit / iCloud Drive
APIs — no third-party sync infrastructure.

Test account: not required (no login flow exists).

The app can be fully evaluated without any network connection.
```

---

## Post-submission checklist

- [ ] App name and subtitle finalized (no changes after submission without re-review)
- [ ] All screenshot sizes uploaded and previewed in App Store Connect
- [ ] Privacy nutrition label complete and accurate
- [ ] Age rating questionnaire complete
- [ ] Support URL: pikos.app (or pikos.app/support)
- [ ] Marketing URL: pikos.app
- [ ] Privacy policy URL: pikos.app/privacy (required for all apps)
- [ ] Copyright field: `© 2026 [your name / company]`
- [ ] Review notes written
- [ ] Build uploaded via Xcode or `xcrun altool` / Transporter
- [ ] Manual release selected (review listing before going live)
- [ ] Family Sharing enabled
- [ ] TestFlight build sent to at least 1 internal tester before submission
