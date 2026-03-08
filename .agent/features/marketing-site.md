# Marketing Site — Feature Spec

GOO-53 · Astro in `apps/marketing/` (monorepo sibling of `apps/desktop/`)

---

## Goals

1. Convert general users (non-technical, Apple ecosystem) into downloads and App Store purchases.
2. Convert technical users (developers, HN readers) into downloads and word-of-mouth.
3. Build an email list before and after launch.
4. Rank organically for "obsidian alternative with tasks", "local-first notes app mac", "private notes app no account", etc.

---

## Tech stack

- **Framework:** Astro (static output, fast by default, no runtime JS required for most pages)
- **Styling:** Tailwind CSS (consistent with desktop app)
- **Analytics:** Plausible (self-hosted or cloud — privacy-respecting, no cookie banner needed)
- **Email capture:** Simple POST to a serverless function (Cloudflare Worker or Vercel) writing to Resend/ConvertKit. No third-party scripts in the critical path.
- **Hosting:** Cloudflare Pages (free tier, CDN, instant cache invalidation)
- **Domain:** pikos.app

---

## Site structure

```
/                   General audience landing page (primary)
/open               Technical / developer landing page
/privacy            Privacy policy (plain language, one page)
/changelog          Release notes (auto-generated from GitHub Releases or a Markdown file)
/download           Download hub (all platforms, version links)
```

No blog at launch. Add `/blog` only if there's content ready to ship. An empty blog is worse than no blog.

---

## Page: `/` — General audience

### Design principles

- **Above the fold must close the sale.** Headline + subheadline + download CTA + one screenshot. Nothing else.
- **No feature lists above the fold.** Features are for people already interested. The headline creates interest.
- **One primary CTA:** Download for Mac (links to `/download` with Mac pre-selected). Secondary: "Coming to iPhone — get notified" email capture.
- **Social proof before features.** 2–3 pull quotes from Phase 2 users immediately below the hero. Real names, real photos (or initials). No stars, no fake reviews.
- **Screenshots over mockups.** Use real app screenshots. Non-technical users trust seeing the real thing.
- **No dark patterns.** No cookie banners (Plausible doesn't need them). No pop-ups. No sticky chat widgets.

### Section order

#### 1. Hero
```
Headline (H1):     Your notes, tasks, and calendar.
                   Private by default.

Subheadline:       Everything in one place. Nothing leaves your device
                   unless you choose it to. No account required.

CTA:               [Download for Mac — Free]   [Get notified for iPhone →]

Social proof tag:  "Works offline. Always."   "No subscription."   "Mac-native."

Screenshot:        Full-width app screenshot — sidebar + editor + calendar panel.
                   Show a realistic day: a few tasks, a note open, calendar events visible.
```

#### 2. Social proof strip
3 quotes, horizontal layout. Phase 2 users. Format: quote → name → role/context.

Example format:
> "I deleted Obsidian and TickTick the same week." — Jordan M., freelance designer

#### 3. The problem (empathy section)
Short copy. No heading needed. Something like:

> You've got notes in one app, tasks in another, and your calendar in a third.
> They don't talk to each other. You're the sync layer.
>
> Pikos is the app that should have existed.

#### 4. Feature showcase — three pillars
Three horizontal cards with screenshot or illustration each:

| Card | Headline | Body |
|------|----------|------|
| Notes | Write anything, find it later. | A rich editor that gets out of the way. Every note lives in your page list. Search is instant — it's all local. |
| Tasks | Every page is a task. | Assign a date, a priority, a status. Schedule it on your calendar. Check it off. No separate task app needed. |
| Calendar | See your week at a glance. | Drag a note onto any day to schedule it. Your work lives in context, not a disconnected to-do list. |

#### 5. Privacy callout (full-width, dark background)
```
Headline: Your data lives on your device.

Body: Pikos stores everything in a local database on your Mac.
      We have no servers, no accounts, no telemetry.
      iCloud sync is optional — and even then, it's Apple's
      infrastructure, not ours. You own your data. Always.
```

No icon soup. One clear statement. This is a differentiator, not a feature checkbox.

#### 6. Comparison table
Target: someone who Googled "obsidian vs ticktick" and landed here.

|                          | Pikos       | Obsidian    | TickTick    | NotePlan    |
|--------------------------|-------------|-------------|-------------|-------------|
| Notes                    | ✓           | ✓           | —           | ✓           |
| Tasks                    | ✓           | Plugin only | ✓           | ✓           |
| Calendar                 | ✓           | Plugin only | ✓           | ✓           |
| Local-first              | ✓           | ✓           | —           | ✓           |
| No account required      | ✓           | ✓           | —           | —           |
| One-time purchase        | ✓           | ✓           | —           | —           |
| Price                    | $19.99      | Free + $96/yr sync | $35.99/yr | $69.99/yr |

Keep this honest. Don't hide where competitors are strong.

#### 7. Pricing section
```
Mac App            $19.99         Buy once. Own forever.
                                  iCloud sync included.
                                  [Download on the Mac App Store]

iPhone app         Coming soon    $9.99 one-time.
                                  [Get notified →]   (email capture)

Direct download    Free           Local only. No iCloud sync.
                                  [Download for Mac]
```

One sentence under the direct download option: "No account, no telemetry, no catch — it's just the app."

Do not show the relay sync subscription here. It's not relevant until cross-platform exists. Add it when Windows ships.

#### 8. Download CTA (footer-adjacent)
Large, repeated CTA before the footer.

```
Headline: Ready to try it?
Body:     Download for Mac. Free. No sign-up.

[Download for Mac]   [Mac App Store]
```

#### 9. Footer
Minimal. Logo · Privacy · Changelog · /open (label: "For developers") · GitHub (if public)

---

## Page: `/open` — Technical / developer audience

### Design principles

- Skip the emotional pitch. This audience buys on architecture, not vibes.
- Lead with the technical story, not the feature list.
- Link to GitHub, data format docs, and the Homebrew cask.
- Be honest about where the app is in its development.

### Section order

#### 1. Hero
```
Headline:    Notes, tasks, and calendar. Local SQLite. No account.

Subheadline: Built on Tauri 2 + React 19 + SQLite. Your data is a single
             SQLite file you can inspect, back up, and own forever.

CTA:         [Download for Mac]   [View on GitHub →]
             or: brew install --cask pikos
```

#### 2. Architecture callout
Short prose + code block showing the DB schema or file path.

> Pikos stores everything in a single SQLite database at `~/Library/Application Support/pikos/default.sqlite`. Open it with any SQLite browser. There's no hidden sync, no analytics, no binary blob format. The schema is readable.

Include a truncated schema snippet.

#### 3. Stack breakdown
```
Desktop:  Tauri 2 (Rust backend) + React 19 (frontend)
Storage:  SQLite via sqlx (Rust). One file per workspace.
Editor:   Tiptap — content stored as JSON, FTS via SQLite FTS5
Sync:     iCloud (via file system, for App Store builds) or optional relay
UI:       shadcn/ui + Tailwind v4
Build:    pnpm monorepo — apps/desktop, packages/core, packages/ui
```

#### 4. Why local-first
Brief. Link to relevant writing (Martin Kleppmann's local-first paper, etc.) if helpful.

#### 5. Open source / source-available note
Honest status: "The source will be made available. Decision pending on license — we'll update this when it's settled."

#### 6. Download / install
```
Mac App Store: $19.99 one-time
Direct download: free
Homebrew: brew install --cask pikos
```

#### 7. Footer
Same as `/`.

---

## Page: `/privacy`

One page. Plain English. No legalese. Structure:

1. **What data we collect:** Nothing. The app runs locally. (Clarify: Plausible analytics on this website collect aggregate page views, no personal data, no cookies.)
2. **iCloud sync:** If you use it, Apple's privacy policy applies. We never see your data.
3. **Relay sync (future):** If you subscribe, your data is E2EE. We can't read it even if we wanted to.
4. **Contact:** email address for questions.

---

## Page: `/download`

Platform tabs: Mac · Windows (coming) · Linux (coming)

Mac section:
- App Store button (badge)
- Direct download `.dmg` button
- Homebrew one-liner
- System requirements: macOS 13+ (Ventura)
- Changelog link

---

## Page: `/changelog`

Markdown file `CHANGELOG.md` at repo root, rendered by Astro. Auto-linked from GitHub Releases via CI. Format: date → version → bullet points. Keep it human — not commit messages.

---

## SEO targets

| Page | Primary keyword | Secondary |
|------|----------------|-----------|
| `/` | private notes app mac | local-first notes app, offline notes app no account |
| `/` | notes tasks calendar one app | obsidian ticktick alternative |
| `/open` | local-first sqlite notes app | obsidian alternative with tasks, tauri notes app |
| `/open` | sqlite notes app mac | open source notes app mac |

**Do not stuff keywords.** Write for humans. The SEO terms appear naturally in the copy if the positioning is clear.

Meta tags for `/`:
```
title: Pikos — Notes, tasks, and calendar. Private by default.
description: Your notes, tasks, and calendar in one Mac app.
             Everything stored on your device. No account required.
             Buy once, own forever.
og:image: app screenshot showing the three-panel layout
```

---

## Email capture

Single field (`email`), POST to a serverless endpoint. No name required. Confirmation email: plain text, no HTML template.

Subject: `You're on the Pikos list`

Body:
> Thanks — you'll hear from me when the iPhone app ships (and for any major updates).
> No spam, no newsletters. One email when something real happens.
> — [your name]

Store in ConvertKit or a simple Airtable/Supabase table. Tag by source (homepage CTA vs. pricing section).

---

## Analytics

Plausible — self-hosted or cloud plan. Track:
- Page views by path
- Download button clicks (custom events: `download_mac_direct`, `download_app_store`, `email_signup`)
- Referrer sources

No Google Analytics. No Meta Pixel. No tracking scripts. Consistent with the privacy story.

---

## Performance targets

- Lighthouse score ≥ 95 on all pages
- No layout shift (CLS = 0)
- First contentful paint < 1s on 4G
- Total JS bundle < 50KB (Astro ships zero JS by default; keep it that way for marketing pages)
- All images: WebP, width/height set, lazy-loaded below fold

---

## Launch checklist

- [ ] Domain configured, HTTPS enforced
- [ ] `/` and `/open` live with real copy
- [ ] `/privacy` live
- [ ] `/download` live with working links
- [ ] App Store badge (official Apple badge, per Apple guidelines)
- [ ] Email capture working end-to-end (test with real email)
- [ ] Plausible installed and recording
- [ ] OG image set for social sharing
- [ ] `sitemap.xml` generated by Astro
- [ ] `robots.txt` — no noindex
- [ ] 404 page that links back to download
- [ ] Mobile responsive (test on real iPhone, not just DevTools)
