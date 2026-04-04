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
- Default experience: dead simple. Create a page. Write in it, schedule it, track it. No setup wizard, no concepts to learn.
- The empty state (day one, no data) must feel welcoming — not a blank canvas that requires a "system."
- Import from Apple Reminders / Google Tasks / Todoist removes the switching cost objection.
- Power features (advanced filters, wikilinks, import/export) live behind discoverable surfaces, not in the critical path.
- Performance and reliability are table stakes. The app must feel instant at all times.

**Tone:** Confident but not loud. The product is the story — not who built it or why. Non-technical users trust calm, honest framing over marketing superlatives. Technical users see through hype instantly. Be the same voice in both rooms.

**On the solo developer angle:** Pikos stands on its own as a product. The origin story is not the pitch. A brief, honest mention on the about page ("Pikos is built and maintained by one person") reinforces the lean, non-bloated positioning without leading with it. This also quietly answers "why won't it get bloated?" without having to say it directly.

---

### Competitive moat

The combination is the moat: fast + private + tasks + calendar + notes in one app. Any single property is replicable. The combination at this quality level isn't. Large incumbents won't execute on a lean tool inside their existing codebase and company structure — their business models depend on complexity.

### Interaction speed principle

Primary actions on a page should be one click from the metadata header. Secondary configuration lives behind that click — but never behind two navigation steps.

TickTick requires click task → click schedule → click reminder dropdown → click cadence (3-4 steps). Pikos should beat this by keeping metadata inline and always visible. The competitive edge is speed of interaction, not feature count.

- Metadata header chips (status, priority, tags, schedule, reminders) are the visual fast lane — one click to act, dropdown/popover for options
- NLP in Quick Add is the power-user fast lane — zero clicks for the same result
- Don't show empty affordances for irrelevant actions (e.g., bell icon only appears when a page has a schedule) — keeps UI clean for simple notes
- Balance: everything top-level makes UI muddy. The test is "does this action apply to most pages?" If yes, it belongs in the header. If no, it belongs behind a menu.

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

> Updated March 31, 2026. Ahead of schedule — friends beta started March 30.

### Timeline overview

```
Mar 2026  ──────────────── Phase 2A core editor & metadata ✓
          ──────────────── Marketing site live ✓
          ──────────────── Friends beta started (March 30) ✓
Apr 2026  ─────── Friends beta feedback + calendar + search/commands
May 2026  ─────── /open page, video demo, branding polish
Jun 2026  ──────────────── Public launch 🚀 (single coordinated moment)
```

**Phase 3 launch ships all at once:**
- Repo goes public (source-available)
- `/open` page live (technical audience)
- `/download` page live (Cloudflare Pages Function → GitHub Releases)
- Mac (.dmg) + Linux (.AppImage, .deb) signed binaries
- Blog launch posts
- No Windows binary — revisit if demand materializes
- Mac App Store is Phase 4 (separate, after launch proves stability)

Pace assumptions: part-time (~a few focused hours/day).

---

### Phase 1 — Dogfood (complete)

Built it for personal use. The sole quality bar was 30 consecutive days using Pikos as the primary tool without falling back to Obsidian or TickTick.

---

### Phase 2 — Friends Beta (in progress)

**Started: March 30, 2026** — ahead of the original late May target.

Sent to friends directly. Distribution via direct download. Collecting feedback through direct conversations — "what did you reach for that wasn't there?"

**Milestone:** 3+ people using it regularly for ≥2 weeks without prompting.

---

### Phase 2.5 — Marketing site (complete)

Marketing site live at pikos.app. Astro + Tailwind, Cloudflare Pages. Homepage with product demo video, blog, release notes, privacy policy, terms. Download CTA on homepage.

---

### Phase 3 — Public Launch

**Target: June 2026**

Not a Product Hunt spike. A quiet, permanent public presence. The goal is for someone Googling "obsidian alternative with tasks" or "local-first calendar notes app" to find Pikos and be able to download it immediately.

**What needs to ship — all at the same time:**
- `/download` page with Mac + Linux buttons (Cloudflare Pages Function redirects to latest GitHub Release assets)
- `/open` page (technical audience — architecture, local-first philosophy, GitHub link)
- Video demo on homepage
- Source-available repo goes public (prerequisite for `/download` — GitHub Releases must be publicly accessible)
- Blog launch posts
- App stable after 2+ weeks of friends beta feedback incorporated
- Command palette, full-text search, undo/redo, and theme selector should be in — but the bar is "stable and complete enough to show strangers," not a checklist

#### Three landing pages (same app, three entry points)

- **`/`** — General audience. Visual, approachable. Headline: *"Notes, tasks, and calendar. One app."* Shows the product in motion (demo video). No mention of SQLite, Tauri, or file paths. Download button prominent above the fold. Focus on the feeling, not the feature list.
- **`/download`** — Platform picker. Mac (.dmg) and Linux (.AppImage, .deb) buttons. Each button is a Cloudflare Pages Function that 302-redirects to the latest GitHub Release asset. Callout: "Want iCloud sync? Coming soon to the Mac App Store." No binaries hosted — GitHub serves them, Cloudflare redirects.
- **`/open`** — Technical audience. Architecture, local-first philosophy, SQLite data ownership, open format. Brief explanation of specific technical decisions (not origin story). Links to GitHub, mentions Homebrew install. Speaks directly to the "I've tried Obsidian + TickTick" pain point with technical specifics.

The three pages let you run different SEO and social campaigns without the messaging feeling split.
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

**Credibility angle:** Technical blog posts about specific decisions (Tauri + SQLite, local-first design, the NL parser approach) drive developer discovery organically and feed the `/open` page. These work better than a "why I built this" narrative — they demonstrate craft and attract the kind of attention that converts to word of mouth.

**Social proof:** Ask Phase 2 beta users for honest quotes. A few real testimonials on the landing page outperform any feature list for non-technical visitors.

---

### Phase 4 — Growth & Monetization

**Target: Q4 2026 / 2027**

After real users exist and feedback is incorporated.

#### Mac App Store

Primary non-technical discovery channel. Sandboxing adds work but the audience is worth it. Submit after Phase 3 proves stability. GOO-52-MAS.

#### Sync

```
APP STORE (Mac App Store + iPhone App Store)
────────────────────────────────────────────────────────────
Mac app      → purchased once from Mac App Store ($19.99)
iPhone app   → purchased once from iOS App Store ($9.99, when it ships)
Sync         → iCloud, automatic, no extra charge
               (uses the user's existing iCloud storage — like Apple Notes)
Revenue      → app purchase prices (Apple takes 30%)

DIRECT DOWNLOAD (website, Homebrew, GitHub)
────────────────────────────────────────────────────────────
Mac/Linux     → downloaded free from pikos.app/download
Sync          → none. Local only.
```

**No sync server. No accounts. No subscriptions. Ever.** This is a deliberate decision, not a deferral. Running sync infrastructure means accounts, billing, ops, and support — all of which dilute the core pitch ("no accounts, no servers, your data stays on your device"). iCloud sync through the App Store covers the primary audience with zero infrastructure cost.

**iCloud sync is exclusive to App Store purchases.** The free direct download is the full app, local only. iCloud sync is the clear, tangible reason to buy the App Store version.

**Technical users who want sync without the App Store** can point Syncthing (or any file-sync tool) at the SQLite database directory. Note: SQLite with WAL mode uses multiple files (db, db-wal, db-shm) and naive file-sync during active writes can corrupt data — this is a "you know what you're doing" option for technical users, not something to recommend broadly. Worth mentioning on `/open` with appropriate caveats as a natural fit for the "your data is yours" positioning.

**Upgrade path:** A user downloads the free .dmg, uses the app locally, then buys the App Store version when they want sync (or when mobile ships). The App Store version picks up the existing local database — same file, same location. No data migration needed.

#### Pricing

| What | Price | Notes |
|---|---|---|
| Mac app (App Store, one-time) | **$19.99** | Buy once, own forever. No subscription. |
| iPhone app (App Store, one-time, future) | **$9.99** | Mobile companion. App Store only. |

**No subscriptions, period.** iCloud sync has no ongoing infra cost. "Buy once, own forever" builds trust with subscription-fatigued users and is a direct competitive advantage.

**Competitive context:** Obsidian Sync is $96/yr. NotePlan is $69.99/yr (subscription only). Pikos is a one-time purchase with sync included — no ongoing cost.

#### Mobile

`packages/core` pure-TS layer was designed for React Native from day one. When mobile ships, sync becomes the natural upgrade path. GOO-47.

---

## Distribution

| Channel | When | Notes |
|---|---|---|
| GitHub Releases | Phase 2+ | Primary distribution, auto-updater source. Private repo during beta, public at Phase 3 launch. |
| `/download` page | Phase 3 | Cloudflare Pages Function → 302 redirect to latest GitHub Release assets. Requires public repo. |
| Homebrew cask | Phase 3+ | Developer-friendly, one-line install. Can ship with launch or shortly after. |
| Mac App Store | Phase 4 | Primary non-technical discovery + iCloud sync upsell. Sandboxing adds work. |
| Linux | Phase 3 | `.AppImage` + `.deb` from Tauri build matrix. No signing required, zero extra work. |
| Windows | — | No binary distribution. Unsigned `.msi` triggers SmartScreen warnings that look like malware to non-technical users. The `/open` audience (developers) can build from source. Revisit if non-technical Windows demand materializes. |

**Download flow at launch:**
```
pikos.app/download  →  Cloudflare Pages Function  →  302 redirect  →  GitHub Release asset
                        (hits GitHub API, finds latest release,
                         matches platform to asset filename)
```
Clean URLs: `/download/mac` → latest `.dmg`, `/download/linux` → latest `.AppImage`. GitHub serves the binary. No binary hosting, no S3, no CDN config. Requires the repo to be public (GitHub Releases return 404 for unauthenticated requests on private repos).

---

## Platform Signing

| Platform | Signing | Cost |
|---|---|---|
| macOS | Required (Gatekeeper blocks unsigned apps) | $99/yr Apple Developer |
| Linux | Not applicable | $0 |

**macOS notarization in practice:** `tauri-apps/tauri-action` GitHub Action automates sign → notarize → upload. Set up secrets once (certificate, passwords, Apple ID, team ID) and every `git tag v*` triggers the full pipeline.

---

## Monetary Model Summary

| Tier | Price | What you get | Revenue path |
|---|---|---|---|
| Free (direct download) | $0 | Full app, local only | — |
| Mac app (App Store) | $19.99 one-time | Full app + iCloud sync | App Store (Apple takes 30%) |
| iPhone app (App Store, future) | $9.99 one-time | Mobile companion + iCloud sync | App Store (Apple takes 30%) |

Free direct download at launch (full app, local only). iCloud sync is exclusive to App Store purchases. No subscriptions, no accounts, no servers to run.

---

## Backlog items from this strategy

- **GOO-51** App branding — icon, wordmark, visual identity
- **GOO-52** macOS signing + notarization + GitHub Releases pipeline
- **GOO-53** Marketing site — ~~Astro in `apps/marketing/`~~ (largely complete: homepage, blog, release notes, privacy, terms)
- **GOO-53-DL** `/download` page + Cloudflare Pages Function redirects (Phase 3 — ships with launch)
- **GOO-53-OPEN** `/open` page for technical audience (Phase 3 — ships with launch)
- **GOO-54** Privacy policy — ~~simple, plain language, one page~~ (complete, live at `/privacy`)
- **GOO-52-MAS** Mac App Store submission (Phase 4 — after launch proves stability)
- Video demo — record after Reddit posts land (Phase 3 gate)
- Import from Apple Reminders / Google Tasks / Todoist — reduces switching cost, no phase assigned yet