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

Pikos is for anyone who wants their notes, tasks, and calendar in one place without their data living on someone else's server. The app should be as approachable as TickTick and as deep as Obsidian — but most users will never need the deep end.

**Primary target: non-technical knowledge workers.** These are the people who pay, stay, and tell friends. They don't evaluate features — they evaluate the first 5 minutes. Technical users are useful for early feedback but are not the primary market.

**High-value non-technical segments:**
- **Freelancers and consultants** — juggling projects, clients, deadlines, call notes. Currently cobbling Notion + Todoist + Google Calendar. Feel the cost of context-switching directly in lost time. Highest willingness to pay.
- **Small business owners** — need task + calendar, don't want per-seat SaaS forever.
- **Writers and journalists** — notes tied to deadlines, research linked to tasks. No good native tool exists.
- **Graduate students** — research notes, deadlines, reading lists. Obsidian is too complex, Notion is too slow. (Useful for early adoption and word of mouth; lower purchase intent than freelancers.)

Early beta users will reveal which segment resonates most. Let them identify themselves, then lean into that framing.

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

**Tone:** Confident but not loud. The product is the story — not who built it or why. Non-technical users trust calm, honest framing over marketing superlatives. Technical users see through hype instantly. Be the same voice in both rooms.

**On the solo developer angle:** Pikos stands on its own as a product. The origin story is not the pitch. A brief, honest mention on the about page ("Pikos is built and maintained by one person") reinforces the lean, non-bloated positioning without leading with it. This also quietly answers "why won't it get bloated?" without having to say it directly.

---

### Competitive moat

The combination is the moat: fast + private + tasks + calendar + notes in one app. Any single property is replicable. The combination at this quality level isn't. Large incumbents won't execute on a lean tool inside their existing codebase and company structure — their business models depend on complexity.

---

## Open Source Decision

**Verdict: Source-available, public repository, restrictive license.**

"Nothing leaves your device" is a claim, not a fact, until someone can verify it. A public repository makes that claim auditable — even non-technical users gain confidence knowing that *someone* can check. This directly reinforces the core privacy positioning.

**License:** Source-available (e.g., BUSL or a custom restrictive license). Code is publicly readable. Commercial redistribution is prohibited. This is not "open source" and shouldn't be presented as such — frame it honestly as "our code is public so you can verify our privacy claims."

**When to open it:** Phase 3, alongside the `/open` page launch. Not before. A half-finished repository undermines the credibility it's meant to build. Open it when it's something worth showing — ideally as a single deliberate moment with a clear narrative.

**What to make public:**
- `apps/desktop` — the whole point
- `apps/marketing` — static Astro site, no risk
- `packages/core` — needed to build desktop; the local-first data model being auditable reinforces the privacy claim
- Tooling, configs, Turborepo setup — unremarkable

**What to keep private:**
- `apps/mobile` when it exists — mobile is the primary monetization lever. It converts free desktop users into paying customers. The open source credibility argument doesn't apply here the same way it does for desktop.

**Repository structure:**
Two repos. Develop in the private monorepo as normal. Maintain a separate public repo that mirrors everything except mobile, synced via CI on each release tag. The public repo starts as a fresh repo with a single initial commit — no history, clean slate. The private monorepo retains full history for your own reference.

**Distribution model:**
- Free binary at `pikos.app/download` — builds trust and word of mouth
- App Store as primary revenue and discovery path for mainstream users
- Technical users who clone and build locally were never going to pay via App Store anyway — no revenue is lost, goodwill is gained

---

## Launch Roadmap (2026 Timeline)

> Baseline: March 12, 2026. Current state: Phase 2 in progress, editor core largely shipped.

### Timeline overview

```
Mar 2026  ──────────────── Phase 2A core editor & metadata
          ──────────────── Marketing site scaffolding + Phase 2.5 landing page (parallel track)
Apr 2026  ─────── Phase 2B calendar (pulled forward) + search/commands
          ─────── Landing page live with email capture
May 2026  ─────── Shipping infrastructure + friends beta
Jun 2026  ─────── Friends beta feedback loop + fixes
Jul 2026  ─────── Full marketing site (/ + /open + /download), video demos, branding
Aug 2026  ──────────────── Public launch 🚀
```

Pace assumptions: part-time (~a few focused hours/day). If full-time, compress by ~6–8 weeks.

Marketing site development runs in parallel to desktop app work — it doesn't block or depend on Phase 2 completion.

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

**Target: March/April 2026 (building in parallel with Phase 2A)**

Marketing site development starts now as a parallel workstream. The Phase 2.5 landing page is the first deliverable — a focused single-page site that starts building an audience immediately.

- One page: hero headline, 2–3 sentences, app screenshot/mockup, email capture ("Get notified when Pikos launches")
- No promises about dates or features
- Stack: Astro in `apps/marketing/` (same monorepo), Tailwind CSS, deployed to Cloudflare Pages
- Start collecting emails the day the page goes live — even 50 signups before launch is a real audience
- This page evolves into the full marketing site (Phase 3) rather than being thrown away

**Email approach:** Two emails total, ever.
1. Signup confirmation — immediate. Reaffirms the promise: one email when it's ready, nothing else.
2. Launch — the email you promised. Direct download link, 3–4 sentences. Treat them like someone who already decided, not someone you're still convincing.

No drip. No nurture. "No newsletters, no noise" is part of the brand — don't undermine it.

Post-launch, email capture comes down. Updates and onboarding live in the app and on the marketing site's release notes page. Never in an inbox.

**Milestone:** Page live at pikos.app, email capture working, at least one social post linking to it.

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
- [ ] Video demo recorded (see Channels below)
- [ ] Source-available repository made public, linked from `/open`

#### Dual landing pages (same app, two entry points)

- **`/`** — General audience. Visual, task-focused, approachable. Headline: *"Your notes, tasks, and calendar. Private by default."* Shows the calendar + task list. No mention of SQLite, Tauri, or file paths. Download button prominent above the fold. Focus on the feeling, not the feature list.
- **`/open`** — Technical audience. Architecture, local-first philosophy, SQLite data ownership, open format. Brief explanation of specific technical decisions (not origin story). Links to GitHub, mentions Homebrew install. Speaks directly to the "I've tried Obsidian + TickTick" pain point with technical specifics.

The two pages let you run different SEO and social campaigns without the messaging feeling split.
- General: "private notes app", "offline task manager", "notes app no account"
- Technical: "local-first notes app", "obsidian alternative with tasks", "sqlite notes app"

#### Launch channels

| Channel | Notes |
|---|---|
| Marketing site | General + technical pages; direct, organic, social |
| **Reddit** | r/productivity, r/macapps, r/selfhosted, r/ObsidianMD. High-intent audience with the exact pain point. Be a genuine participant, not a promoter. Post after the app is stable and you can respond to feedback confidently. |
| **YouTube** | One demo video. Focus on the product in motion — not why it was built. Show a real workflow: add a task, link it to a note, drag it to the calendar. Non-technical users discover apps via YouTube far more than HN. Honest and unpolished beats polished ad. Record this *after* at least one Reddit post lands well so there's already community momentum to point to. |
| Hacker News | One well-timed "Show HN" post — link to `/open`. Lead with a specific technical decision, not a pitch. Do this after Reddit posts have landed so you have real user responses to reference. |
| GitHub | Source-available repository. Technical credibility and organic discovery channel. Opened at Phase 3 launch alongside `/open`. |
| Personal social | Occasional, not performative. Link to both landing pages. |
| Email list | The Phase 2.5 list gets the launch announcement first. Even 50 people is a real audience. |

**Credibility angle:** Technical blog posts about specific decisions (Tauri + SQLite, local-first design, the NL parser approach) drive developer discovery organically and feed the `/open` page. These work better than a "why I built this" narrative — they demonstrate craft and attract the kind of attention that converts to word of mouth.

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