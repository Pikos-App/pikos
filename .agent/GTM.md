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

## Launch Roadmap (2026 Timeline)

> Baseline: March 12, 2026. Current state: Phase 2 in progress, editor core largely shipped.

### Timeline overview

```
Mar 2026  ──────────────── Phase 2A core editor & metadata
Apr 2026  ─────── Phase 2B calendar (pulled forward) + search/commands
May 2026  ─────── Shipping infrastructure + friends beta
Jun 2026  ─────── Friends beta feedback loop + fixes
Jul 2026  ─────── Marketing site, video demos, branding
Aug 2026  ──────────────── Public launch 🚀
```

Pace assumptions: part-time (~a few focused hours/day). If full-time, compress by ~6–8 weeks.

---

### Phase 1 — Dogfood (complete)

Built it for personal use. The sole quality bar was 30 consecutive days using Pikos as the primary tool without falling back to Obsidian or TickTick.

---

### Phase 2 — Friends Beta

**Target: late May 2026**

Invite 5–15 people directly. Technically comfortable friends — people who won't be blocked by a rough edge but will tell you honestly what's broken.

#### Gate checklist — must ship before inviting anyone

- [ ] GOO-32 Collapsible metadata header
- [ ] GOO-33 Page status toggle
- [ ] GOO-35 Priority selector
- [ ] GOO-19 NL parser + GOO-60 Quick Add Modal (`Cmd+N` flow)
- [ ] GOO-34 Scheduled date/time picker
- [ ] **GOO-21 Calendar day view** ← _pulled forward from Phase 4, required for the core pitch_
- [ ] **GOO-39 Drag page → calendar** ← _pulled forward, required for the core pitch_
- [ ] GOO-51 App icon + branding (unsigned Gatekeeper DMG looks unfinished)
- [ ] GOO-52 macOS notarized builds + GitHub Releases CI pipeline ← _external dep: Apple Developer account_
- [ ] GOO-50 Auto-updater (so you can push fixes without asking people to reinstall)

**What to skip** until after friends beta feedback: settings modal, import/export, tags, command palette, undo/redo, search. These don't block the core loop.

**Distribution:** Direct download link from GitHub Releases. No marketing site needed yet.

**Feedback approach:** Direct conversations. Not a survey. Ask "what did you reach for that wasn't there?" One useful session beats a hundred form responses.

**Milestone:** 3+ people using it regularly for ≥2 weeks without prompting.

---

### Phase 2.5 — Landing page + email list

**Target: April/May 2026 (before friends beta even starts)**

A simple landing page with an email capture field costs nothing and starts building an audience now.

- One page: headline, 2–3 sentences, screenshot, email field ("Get notified when Pikos launches")
- No promises about dates or features
- Start collecting emails the day the page goes live — even 50 signups before launch is an audience

**Milestone:** Page live, email capture working, at least one social post linking to it.

---

### Phase 3 — Public Launch

**Target: August 2026** _(compress to late June/July if full-time)_

Marketing site live. Download available to anyone. No sign-up required.

**What "launch" means here:** Not a Product Hunt spike. A quiet, permanent public presence. The goal is for someone Googling "obsidian alternative with tasks" or "local-first calendar notes app" to find Pikos and be able to download it immediately.

#### Gate checklist — must ship before marketing site goes live with a download button

- [ ] All friends beta gate items (above) ✓
- [ ] GOO-17 Command palette (`Cmd+P`)
- [ ] GOO-18 FTS5 full-text search
- [ ] GOO-62 Undo/redo
- [ ] GOO-97 Theme selector (system/light/dark)
- [ ] GOO-53 Marketing site live — two pages: `/` (general) + `/open` (technical)
- [ ] GOO-54 Privacy policy at `/privacy`
- [ ] App stable after 2+ weeks friends beta feedback incorporated
- [ ] Video demo recorded (1× "why I built Pikos" style, honest and unpolished)
- [ ] Open source decision made (source-available / MIT / closed — see below)

#### Dual landing pages (same app, two entry points)

- **`/`** — General audience. Visual, task-focused, approachable. Headline: *"Your notes, tasks, and calendar. Private by default."* Shows the calendar + task list. No mention of SQLite, Tauri, or file paths. Download button prominent above the fold. Focus on the feeling, not the feature list.
- **`/open`** — Technical audience. Architecture, local-first philosophy, SQLite data ownership, open format. Brief "why I built this" story. Links to GitHub, mentions Homebrew install. Speaks directly to the "I've tried Obsidian + TickTick" pain point with technical specifics.

The two pages let you run different SEO and social campaigns without the messaging feeling split.
- General: "private notes app", "offline task manager", "notes app no account"
- Technical: "local-first notes app", "obsidian alternative with tasks", "sqlite notes app"

#### Launch channels

| Channel | Notes |
|---|---|
| Marketing site | General + technical pages; direct, organic, social |
| **Reddit** | r/productivity, r/macapps, r/selfhosted, r/ObsidianMD. High-intent audience with the exact pain point. Be a genuine participant, not a promoter. |
| **YouTube** | One "why I built Pikos" video. Non-technical users discover apps via YouTube far more than HN. Honest and unpolished beats polished ad. |
| Hacker News | One well-timed "Show HN" post — link to `/open`. Do this after a few Reddit posts land well so you have momentum. |
| GitHub | Source-available or open source. Builds technical credibility and is an organic discovery channel. |
| Personal social | Occasional, not performative. Link to both landing pages. |
| Email list | The Phase 2.5 list gets the launch announcement first. Even 50 people is a real audience. |

**Credibility angle:** Technical blog posts about interesting decisions (Tauri + SQLite, local-first design, React 19 compiler) drive developer discovery organically and feed the `/open` page.

**Social proof:** Ask Phase 2 beta users for honest quotes. A few real testimonials on the landing page outperform any feature list for non-technical visitors.

---

### Phase 4 — Growth & Monetization

**Target: Q4 2026 / 2027**

After real users exist and feedback is incorporated.

#### Mac App Store

Primary non-technical discovery channel. Sandboxing adds work but the audience is worth it. Submit after Phase 3 proves stability. GOO-52-MAS.

#### Sync paths

Two completely separate sync lanes — they don't need to overlap and shouldn't share a payment mechanism.

```
PATH A — APPLE ECOSYSTEM (Mac App Store + iPhone App Store)
────────────────────────────────────────────────────────────
Mac app      → purchased once from Mac App Store
iPhone app   → purchased once from iOS App Store (when it ships)
Sync         → iCloud, automatic, no account, no extra charge
               (uses the user's existing iCloud storage — like Apple Notes)
Revenue      → app purchase prices (Apple takes 30% / 15% for subscriptions)

PATH B — DIRECT DOWNLOAD (website, Homebrew, GitHub)
────────────────────────────────────────────────────────────
Mac/Win/Linux → downloaded free from pikos.app
Sync          → optional: create account → your relay server
Revenue       → subscription via Paddle or Lemon Squeezy (you keep ~95%)
```

iCloud sync works in direct-download Mac apps too (users just need an Apple ID). This means a website user on Mac can sync to their iPhone via iCloud without ever buying the App Store version.

**The bypass question:** A user can download Pikos free from the website, use iCloud sync, and never pay anything. This is fine — zero marginal cost, and free users spread the product. The iPhone App Store app is the natural paywall for Apple ecosystem users. The paying customers for relay sync are Windows/Android users who can't bypass anything — they genuinely need your server.

#### Pricing

| What | Price | Notes |
|---|---|---|
| Mac app (App Store, one-time) | **$19.99** | Buy once, own forever. No subscription. |
| iPhone app (App Store, one-time, future) | **$9.99** | Mobile companion. App Store only. |
| Relay sync (annual, via your site) | **$39.99/yr** | Cross-platform sync. E2EE on your server. |
| Relay sync (monthly, via your site) | **$4.99/mo** | Same as $59.88/yr — surface annual prominently. |
| Self-hosted relay | **$0** | Run your own server. Builds goodwill with privacy audience. |

**Why one-time purchase (not subscription) for App Store:**
- iCloud sync has no ongoing infra cost to justify a subscription
- "Buy once, own forever" builds trust with subscription-fatigued users
- Relay sync is already a recurring line; two subscriptions for one app is confusing
- Churn anxiety doesn't apply to one-time pricing

**Competitive context:** Obsidian Sync is $96/yr. NotePlan is $69.99/yr (subscription only). At $39.99/yr for relay sync, Pikos undercuts both while being more integrated.

**Don't build relay infrastructure until there are paying customers to justify the operational overhead.** iCloud sync ships first — it's the proof that sync works.

#### Mobile

`packages/core` pure-TS layer was designed for React Native from day one. When mobile ships, sync becomes the natural upgrade path. GOO-47.

---

## Distribution

| Channel | When | Notes |
|---|---|---|
| GitHub Releases | Phase 2+ | Primary distribution, auto-updater source |
| Marketing site direct download | Phase 3 | Links to GitHub Releases |
| Homebrew cask | Phase 3 | Developer-friendly, one-line install |
| Mac App Store | Phase 4 | Primary non-technical discovery. Sandboxing adds work. |
| Windows | Phase 3 | Tauri builds `.msi`/`.exe`. SmartScreen warns without signing cert — acceptable for early adopters. |
| Linux | Phase 3 | Tauri builds `.AppImage` + `.deb`. No signing required. Low friction to add to CI matrix. |

---

## Platform Signing

| Platform | Signing | Cost |
|---|---|---|
| macOS | Required (Gatekeeper blocks unsigned apps) | $99/yr Apple Developer |
| Windows | Optional — SmartScreen warns but doesn't block | ~$300–500/yr OV cert (skip for Phase 2, add before wide launch) |
| Linux | Not applicable | $0 |

**macOS notarization in practice:** `tauri-apps/tauri-action` GitHub Action automates sign → notarize → upload. Set up secrets once (certificate, passwords, Apple ID, team ID) and every `git tag v*` triggers the full pipeline.

---

## Open Source Decision

**Decide before Phase 3 launch.** Options:

- **Source-available** (code public, use restricted): lets developers audit privacy claims; doesn't hand SaaS competitors a free hosted version
- **Fully open source** (MIT/Apache): easier contributions; harder monetization
- **Closed source**: simpler; less credibility for privacy-focused audience

Don't decide on a half-finished app. Revisit when Phase 2 feedback is incorporated and the codebase is something worth showing.

---

## Monetary Model Summary

| Tier | Price | What you get | Revenue path |
|---|---|---|---|
| Free (direct download) | $0 | Full app, local only | — |
| Mac app (App Store) | $19.99 one-time | Full app + iCloud sync | App Store (Apple takes 30%) |
| iPhone app (App Store, future) | $9.99 one-time | Mobile companion + iCloud sync | App Store (Apple takes 30%) |
| Relay sync | $39.99/yr or $4.99/mo | Cross-platform sync, E2EE | Paddle/Lemon Squeezy (~95% to you) |
| Self-hosted relay | $0 | Run your own server | Goodwill |

Free at launch. iCloud sync ships with Phase 4a (no extra charge, no relay infra needed). Relay sync and the paid subscription tier come with Phase 4b when Windows/Android users exist and ask for it.

---

## Backlog items from this strategy

- **GOO-51** App branding — icon, wordmark, visual identity
- **GOO-52** macOS signing + notarization + GitHub Releases pipeline
- **GOO-53** Marketing site — Astro in `apps/marketing/` (monorepo)
- **GOO-54** Privacy policy — simple, plain language, one page
- **GOO-52-MAS** Mac App Store submission (Phase 4)
