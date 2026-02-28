# Go-To-Market Strategy

## What Pikos is

A private-by-design personal knowledge and calendar app. The pitch in one line:

> **Your notes, tasks, and calendar — in one app, on your device, no accounts required.**

The product Pikos replaces: Obsidian (notes) + TickTick (tasks + calendar). Neither does both well. No existing app does both well while being local-first and privacy-honest.

---

## Positioning

**Core promise:** Your data is a SQLite file on your device. Pikos has no servers. It cannot read your notes.

**Against Obsidian:** Obsidian is notes-only, no native task management, plugin ecosystem is fragmented, sync costs $8/mo. Pikos is unified.

**Against TickTick:** TickTick is tasks-first, notes are second-class, cloud-dependent, no real privacy story. Pikos is local-first.

**Against NotePlan** (closest competitor — markdown + calendar, macOS/iOS): NotePlan uses file-based markdown, no structured metadata, weaker calendar, $69.99/yr. Pikos has a richer data model and better privacy controls.

**Who Pikos is for:** Technically comfortable people who care about owning their data — developers, designers, writers who have bounced off the privacy-invasive defaults of mainstream productivity tools.

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

### Phase 3 — Public launch

Marketing site live. Download available to anyone. No sign-up required.

**What "launch" means here:** Not a Product Hunt moment with a spike of traffic. A quiet, permanent public presence. The goal is for someone Googling "obsidian alternative with tasks" or "local-first calendar notes app" to find Pikos and be able to download it immediately.

**Prerequisites:**

- GOO-53: Marketing site live with download button + Plausible analytics
- GOO-54: Privacy policy (honest, plain language, one page)
- GOO-51: App icon and branding finalized
- GOO-52: All three platform builds in CI (macOS signed + notarized, Windows + Linux)
- App is genuinely stable and has survived Phase 2

**Credibility angle:** The app itself is the portfolio piece. The marketing site can have a brief "why I built this" story — not a startup pitch, just honest context. Technical blog posts about interesting decisions (Tauri + SQLite, local-first design, React Compiler) drive developer discovery organically.

**Channels:**

- Marketing site (direct + organic search)
- GitHub (open source or source-available — see below)
- Personal social presence (occasional, not performative)
- Hacker News / indie hackers when the time is right (one "Show HN" post, well-timed)

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

---

## Distribution

| Channel                        | When     | Notes                                                                            |
| ------------------------------ | -------- | -------------------------------------------------------------------------------- |
| GitHub Releases                | Phase 2+ | Primary distribution, auto-updater source                                        |
| Marketing site direct download | Phase 3+ | Links to GitHub Releases                                                         |
| Homebrew cask                  | Phase 3+ | Developer-friendly, one-line install                                             |
| Mac App Store                  | Future   | More friction (sandboxing, Apple review, 30% cut) — evaluate after public launch |
| Windows                        | Phase 3+ | Tauri builds `.msi`/`.exe`. No signing required to run; Windows Defender/SmartScreen will warn without a code signing cert — acceptable for early adopters, fix before wide distribution |
| Linux                          | Phase 3+ | Tauri builds `.AppImage` + `.deb`. No signing required. Low friction to add to CI matrix. |

---

## Platform targets + signing complexity

**Goal: Mac + Windows + Linux from Phase 3.** Tauri supports all three with minimal extra effort once the Mac build is working.

| Platform | Signing | Complexity | Cost |
| -------- | ------- | ---------- | ---- |
| macOS | Required (Gatekeeper blocks unsigned apps) | Moderate — one-time cert setup (~2-3 hrs), then fully automated | $99/yr (Apple Developer) |
| Windows | Optional — SmartScreen warns but doesn't block | Low — skip for Phase 2, add OV cert before wide launch | ~$300–500/yr (OV cert from a CA) |
| Linux | Not applicable | Trivial — add ubuntu runner to CI matrix | $0 |

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
