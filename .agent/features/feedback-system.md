# Feedback System — Plan

## Problem

Need a way to capture bug reports, feature requests, and general feedback from users without violating the privacy-first positioning. No in-app analytics, no telemetry, no tracking. Everything user-initiated and optional.

---

## Decision: Three Channels

### 1. Bug Reports → Structured form at pikos.app/bugs

Bugs need structure that Fider can't provide. A dedicated form on the marketing site with guided fields gets usable reports from any user — technical or not. No GitHub account required, no learning curve. The app links to this form with query params that auto-fill version and OS.

**Form fields:**
- What happened? (required, textarea)
- Steps to reproduce (required, textarea)
- What did you expect? (optional, textarea)
- App version (auto-filled via query param, text input)
- OS and version (auto-filled via query param, text input)
- Email (optional — "Only if you want to hear back about this bug")

**Query param contract with the desktop app:**
```
https://pikos.app/bugs?version=0.4.2&os=macOS+14.4
```
The app constructs this URL at runtime from its own version and the OS info it already has. The form reads the params and pre-fills the fields. User just describes the bug and submits.

**Backend:**
- The form is a static page on the marketing site (no Astro SSR needed)
- Client-side JS POSTs to `api.pikos.app/bugs` (home server)
- Home server API: lightweight endpoint that validates and inserts into Postgres
- Same Postgres instance that Fider uses (or a separate DB — your call)
- Success response renders inline: "Got it. If you left your email, I'll follow up."
- You triage from the DB directly, or build a simple admin view later

**Why not Astro SSR:**
- Keeps the marketing site fully static on Cloudflare Pages — no adapter, no runtime dependency
- The form is a static `.astro` page with a `<form>` that submits via `fetch()` to the home server
- CORS: home server API allows `Origin: https://pikos.app`

### 2. Feature Requests → Self-hosted Fider at feedback.pikos.app

Public board with upvoting. Users browse existing requests, upvote, and submit new ones. You get prioritization signal without asking.

**Key properties:**
- Self-hosted on home server via Coolify — no third-party data sharing
- Subdomain: `feedback.pikos.app`
- Fully public board — anyone can browse, upvote, and submit
- Anonymous posting supported (no account required)
- Optional email for notifications on status changes
- You moderate and respond as the admin
- Tags for organization: Notes, Tasks, Calendar, Import/Export, etc.

**Fider setup:**
- Docker image: `getfider/fider`
- Needs: Postgres, SMTP for optional email notifications
- Custom branding to match pikos.app look (logo, colors)
- Cloudflare DNS: CNAME `feedback.pikos.app` → home server

### 3. General Feedback → Email

Zero-friction, personal, fits the indie dev brand.

- Pikos domain email: `hey@pikos.app`
- "Send Feedback" link opens `mailto:hey@pikos.app?subject=Pikos%20Feedback`
- Listed on marketing site footer and `/feedback` page

---

## What NOT to do

- **No in-app forms or network requests.** The app stays offline. Links open in the browser. Non-negotiable per the privacy pact.
- **No analytics/telemetry for usage patterns.** You learn what users want by what they tell you, not by watching them.
- **No required accounts anywhere.** Bug form is anonymous. Fider allows anonymous posting. Email is optional on both.

---

## Marketing Site Changes

### New pages

| Page | Purpose |
|------|---------|
| `/feedback` | Hub page with three paths: report a bug, request a feature, send feedback. Links to `/bugs`, `feedback.pikos.app`, and `mailto:hey@pikos.app`. |
| `/bugs` | Structured bug report form. Static page, client-side POST to home server API. |

Marketing site stays fully static on Cloudflare Pages. The bug form uses client-side `fetch()` to POST to the home server — no SSR adapter needed.

### Footer update

Add to the marketing site footer:
```
Feedback · Report a Bug · Request a Feature
```

### Help links in the desktop app

Add to settings or help menu:
- Report a Bug → `pikos.app/bugs?version={version}&os={os}`
- Request a Feature → `feedback.pikos.app`
- Send Feedback → `mailto:hey@pikos.app?subject=Pikos%20Feedback`

---

## Infrastructure

### Home server (Coolify)

| Service | Purpose | Stack |
|---------|---------|-------|
| Fider | Feature request board with upvoting | Docker + Postgres |
| Bug report API | Receives bug form submissions | Lightweight API (Node, Go, or Python) + Postgres |

Both services can share a Postgres instance or use separate DBs — depends on how you want to manage backups and access.

### DNS

```
pikos.app          → Cloudflare Pages (existing)
feedback.pikos.app → Home server (Coolify / Fider)
api.pikos.app      → Home server (Coolify / bug report API)
```

### SMTP

Fider needs SMTP for optional email notifications. Options:
- Resend (free tier: 100 emails/day — more than enough)
- Cloudflare Email Routing
- Self-hosted on home server

---

## Implementation Order

1. **Set up Pikos email** (`hey@pikos.app`) — Cloudflare Email Routing or provider of choice
2. **Deploy Fider on Coolify** — Docker compose with Postgres, DNS, SMTP, branding
3. **Build bug report API on Coolify** — lightweight endpoint, Postgres table, CORS for pikos.app
4. **Add `/bugs` form to marketing site** — static page, client-side fetch to api.pikos.app
5. **Add `/feedback` hub page to marketing site** — links to all three channels
6. **Seed the Fider board** — create initial posts for known feature ideas
7. **Update marketing site footer** — add feedback links
8. **Add help menu links in desktop app** — opens browser URLs with query params

Steps 1-3 are infra. Steps 4-8 are straightforward once the services are live.

---

## GitHub Issues

When the repo goes public at Phase 3, technical users will file bugs on GitHub anyway — and that's fine. The structured issue templates are already set up (bug report with fields, feature request linking to Fider). GitHub Issues and the bug form coexist: technical users use GitHub, everyone else uses `pikos.app/bugs`. You triage from both places.
