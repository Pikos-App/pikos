# Go-To-Market Strategy

## What Pikos is

A private-by-design personal knowledge and calendar app. The pitch in one line:

> **Your notes, tasks, and calendar — in one app, on your device, no accounts required.**

The product Pikos replaces: Obsidian (notes) + TickTick (tasks + calendar). Neither does both well. No existing app does both well while being local-first and privacy-honest.

---

## Positioning

**Core promise:** Your notes, tasks, and calendar — private by default. Nothing leaves your device unless you choose it to.

**Against Obsidian:** Notes-only, no real task management, plugin ecosystem is fragmented, sync costs $8/mo. Pikos is unified and has a built-in calendar.

**Against TickTick:** Tasks-first, notes are second-class, cloud-dependent, no real privacy story. Pikos is local-first with equal footing for notes and tasks.

**Against NotePlan** (closest competitor — markdown + calendar, macOS/iOS): File-based markdown, no structured metadata, weaker calendar, $69.99/yr. Pikos has a richer data model and a cleaner UX.

**Against Notion/Obsidian/Craft:** All require accounts or cloud sync by default. Pikos requires neither.

---

### Who Pikos is for

Pikos is for **anyone** who wants their notes, tasks, and calendar in one place without their data living on someone else's server. The app should be as approachable as TickTick and as deep as Obsidian — but most users will never need the deep end.

**Primary target: non-technical knowledge workers.** These are the people who pay, stay, and tell friends. They don't evaluate features — they evaluate the first 5 minutes. Technical users are useful for early feedback but are a bad primary market: vocal, high-churn, and increasingly "I'll just build my own."

**High-value non-technical segments:**
- **Freelancers and consultants** — juggling projects, clients, deadlines, call notes. Currently cobbling Notion + Todoist + Google Calendar.
- **Graduate students** — research notes, deadlines, reading lists. Obsidian is too complex, Notion is too slow.
- **Writers and journalists** — notes tied to deadlines, research linked to tasks. No good native tool exists.
- **Small business owners** — need task + calendar, don't want per-seat SaaS forever.

**Two real audiences, one brand — two front doors:**

| Audience | Primary channel | How they find Pikos | Privacy framing |
|---|---|---|---|
| General users | Marketing `/`, App Store, Reddit, YouTube | "My to-dos, notes, and calendar, all in one place. Fast. No sign-up." | "Nothing goes to the cloud." |
| Power users / developers | `/open`, Hacker News, GitHub, Homebrew | "Local SQLite, no servers, structured data, open format I can inspect." | "The data file is yours. Here's where it lives." |

The product pitch and UX defaults serve the general user. Power-user depth is progressively disclosed — available but never required.

**What this means for the app:**
- Default experience: dead simple. Create a task. Add a note. See your calendar. No setup wizard, no concepts to learn.
- The empty state (day one, no data) must feel welcoming — not a blank canvas that requires a "system."
- Import from Apple Reminders / Google Tasks / Todoist removes the switching cost objection.
- Power features (advanced filters, wikilinks, import/export) live behind discoverable surfaces, not in the critical path.
- Performance and reliability are table stakes. The app must feel instant at all times.

**Tone:** Confident but not loud. "We built the thing we couldn't find" — not "the last app you'll ever need." Non-technical users trust calm, honest framing over marketing superlatives. Technical users see through hype instantly. Be the same voice in both rooms.

---

### Competitive moat

The combination is the moat: fast + private + tasks + calendar + notes in one app. Any single property is replicable. The combination at this quality level isn't.

---

## Launch Phases

### Phase 1 — Dogfood (current)

Build it for personal use. Replace Obsidian + TickTick completely.

**Milestone:** 30 consecutive days using Pikos as the primary tool without falling back to Obsidian or TickTick. This is the only meaningful quality bar before sharing with anyone.

Nothing to distribute, no marketing. Just build.

---

### Phase 2 — Friends beta

Invite 5–15 people directly. Technically comfortable friends — people who won't be blocked by a rough edge but will tell you honestly what's broken.

**Prerequisites before this phase:**

- GOO-52: Notarized macOS builds (unsigned apps trigger Gatekeeper, non-technical friends can't install them). Windows/Linux builds available but signing optional at this stage — technical friends can dismiss SmartScreen.
- GOO-50: Auto-updater wired (so you can push fixes without asking people to reinstall)
- Core flows working: create page, edit, schedule, calendar view

**Distribution:** Direct download link from GitHub Releases. No marketing site needed yet.

**Feedback approach:** Direct conversations. Not a survey. Ask "what did you reach for that wasn't there?"

**Milestone:** 3+ people using it regularly for ≥2 weeks without prompting.

---

### Phase 2.5 — Landing page + email list (before public launch)

**Don't wait for Phase 3 to have a web presence.** A simple landing page with an email capture field costs nothing and starts building an audience while the app is still being built.

- One page: headline, 2–3 sentences, screenshot or mockup, email field ("Get notified when Pikos launches")
- No promises about dates or features
- Start collecting emails the day the page goes live — even 50 signups before launch is an audience

**Milestone:** Page live, email capture working, at least one social post linking to it.

---

### Phase 3 — Public launch

Marketing site live. Download available to anyone. No sign-up required.

**What "launch" means here:** Not a Product Hunt moment with a spike of traffic. A quiet, permanent public presence. The goal is for someone Googling "obsidian alternative with tasks" or "local-first calendar notes app" to find Pikos and be able to download it immediately.

**Prerequisites:**

- GOO-53: Marketing site live with download button + Plausible analytics
- GOO-54: Privacy policy (honest, plain language, one page)
- GOO-51: App icon and branding finalized
- GOO-52: All three platform builds in CI (macOS signed + notarized, Windows + Linux)
- App is genuinely stable and has survived Phase 2

**Dual landing pages (same app, two entry points):**

- `/` — General audience. Visual, task-focused, approachable. Headline: *"Your notes, tasks, and calendar. Private by default."* Shows the calendar + task list. No mention of SQLite, Tauri, or file paths. Download button prominent above the fold. Focus on the feeling, not the feature list.
- `/open` or `/for-developers` — Technical audience. Architecture, local-first philosophy, SQLite data ownership, open format. Brief "why I built this" story. Links to GitHub, mentions Homebrew install. Speaks directly to the "I've tried Obsidian + TickTick" pain point with technical specifics.

The two pages let you run different SEO and social campaigns without the messaging feeling split. General landing page targets: "private notes app", "offline task manager", "notes app no account". Technical page targets: "local-first notes app", "obsidian alternative with tasks", "sqlite notes app".

**Credibility angle:** Technical blog posts about interesting decisions (Tauri + SQLite, local-first design, React Compiler) drive developer discovery organically and feed the `/for-developers` page.

**Channels:**

- Marketing site — general page (direct, organic, social)
- Marketing site — technical page (Hacker News, developer communities, GitHub)
- GitHub (open source or source-available — see below)
- Personal social presence (occasional, not performative)
- Hacker News / indie hackers when the time is right (one "Show HN" post, well-timed — link to technical page)
- **Reddit:** r/productivity, r/macapps, r/selfhosted, r/ObsidianMD. Warm audiences with the exact pain point. Be a genuine participant, not a promoter.
- **YouTube:** A single "why I built Pikos" video gets indexed permanently. Non-technical users discover apps through YouTube searches ("best notes app for Mac", "notion alternative offline") far more than HN. One honest, unpolished video beats a polished ad.
- **Social proof:** Ask Phase 2 users for honest quotes. A few real testimonials on the landing page outperform any feature list for non-technical visitors.

---

### Phase 4 — Growth & monetization

After real users exist and feedback is incorporated.

**Mobile:** GOO-47 (React Native). The `packages/core` pure-TS layer was designed for this from day one. When mobile ships, sync becomes the natural upgrade path.

**Introduce paid sync:**

- Free: full desktop app, unlimited everything, local only
- Paid (~$5/mo or $45/yr): cross-platform sync (desktop + mobile)
- Self-hosted sync: free — respects the privacy positioning and builds goodwill with the audience that cares most

The split is clean: the free app is a complete product, not a crippled demo. Sync is genuinely additive infrastructure, not a paywall over core features.

**Pricing notes:** Obsidian Sync is $96/yr, NotePlan is $69.99/yr. Pikos can undercut both while being more integrated. Don't race to the bottom — $45/yr is reasonable and sustainable.

**Sync options (decide before mobile ships):**

| Option | Complexity | Privacy story | Non-technical UX |
|---|---|---|---|
| iCloud only | Low — Apple handles infra | Good ("stays in your iCloud") | Excellent — zero setup on Apple devices |
| Custom relay (E2EE) | High — you own the server | Strongest ("we can't read it") | Requires explaining |
| iCloud first, relay later | Medium | Good then great | Start simple, add later |

iCloud-only sync is a legitimate long-term choice: zero infra cost, zero operational burden, excellent UX for the Apple-device majority, and a credible privacy story. The tradeoff is Windows/Android users get nothing. Given the macOS-first positioning this is acceptable, especially early. Decide before mobile, not before desktop launch.

**Sync architecture note:** SQLite as source of truth makes sync tractable. CR-SQLite (CRDTs on SQLite) or an event log pattern are the two cleanest approaches. Don't build this until there are paying customers to justify the operational overhead.

---

## Distribution

| Channel                        | When     | Notes                                                                                                                                                                                    |
| ------------------------------ | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GitHub Releases                | Phase 2+ | Primary distribution, auto-updater source                                                                                                                                                |
| Marketing site direct download | Phase 3+ | Links to GitHub Releases                                                                                                                                                                 |
| Homebrew cask                  | Phase 3+ | Developer-friendly, one-line install                                                                                                                                                     |
| Mac App Store                  | Phase 4+ | Primary non-technical discovery channel. 30% cut but reaches users who will never find a GitHub release. Evaluate after public launch — sandboxing adds work but the audience is worth it. |
| Windows                        | Phase 3+ | Tauri builds `.msi`/`.exe`. No signing required to run; Windows Defender/SmartScreen will warn without a code signing cert — acceptable for early adopters, fix before wide distribution |
| Linux                          | Phase 3+ | Tauri builds `.AppImage` + `.deb`. No signing required. Low friction to add to CI matrix.                                                                                                |

---

## Platform targets + signing complexity

**Goal: Mac + Windows + Linux from Phase 3.** Tauri supports all three with minimal extra effort once the Mac build is working.

| Platform | Signing                                        | Complexity                                                      | Cost                             |
| -------- | ---------------------------------------------- | --------------------------------------------------------------- | -------------------------------- |
| macOS    | Required (Gatekeeper blocks unsigned apps)     | Moderate — one-time cert setup (~2-3 hrs), then fully automated | $99/yr (Apple Developer)         |
| Windows  | Optional — SmartScreen warns but doesn't block | Low — skip for Phase 2, add OV cert before wide launch          | ~$300–500/yr (OV cert from a CA) |
| Linux    | Not applicable                                 | Trivial — add ubuntu runner to CI matrix                        | $0                               |

**macOS notarization in practice:** Apple requires apps to be signed with a Developer ID cert and submitted to their notarization service. The `tauri-apps/tauri-action` GitHub Action automates all of this — you set up secrets once (certificate, passwords, Apple ID, team ID) and every release tag triggers a full build → sign → notarize → upload pipeline. The one-time setup takes a few hours; after that it's push-and-done.

**Windows SmartScreen:** Without a code signing cert, Windows shows "Unknown publisher — this may harm your computer." Technical users can bypass it (More info → Run anyway). Acceptable for Phase 2 friends beta; get a cert before wide public distribution.

---

## Open source question

**Decision deferred — decide before Phase 3 launch.**

Options on the table:

- **Source-available** (code is public, use is restricted): lets developers audit privacy claims; doesn't hand SaaS competitors a free hosted version
- **Fully open source** (MIT/Apache): easier community contributions; harder monetization
- **Closed source / download-only**: simpler, no decision to maintain; less credibility signal for privacy-focused audience

Don't decide on a half-finished app. Revisit when Phase 2 feedback is incorporated and the codebase is something worth showing.

---

## Monetary model summary

| Tier        | Price             | What you get                                                 |
| ----------- | ----------------- | ------------------------------------------------------------ |
| Free        | $0                | Full desktop app, unlimited notes/tasks/calendar, local only |
| Sync        | ~$5/mo or ~$45/yr | Cross-platform sync (desktop + mobile)                       |
| Self-hosted | $0                | Run your own sync server                                     |

Free at launch. Introduce paid tier when sync + mobile are ready. No feature gating in the free tier — the privacy promise is the product, and charging for core features would undermine it.

---

## Backlog items from this strategy

- **GOO-51** App branding — icon, wordmark, visual identity
- **GOO-52** macOS signing + notarization + GitHub Releases pipeline
- **GOO-53** Marketing site — Astro in `apps/marketing/` (monorepo)
- **GOO-54** Privacy policy — simple, plain language, one page
