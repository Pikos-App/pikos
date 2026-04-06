# Feedback System — Plan

## Problem

Need a way to capture bug reports, feature requests, and general feedback from users without violating the privacy-first positioning. No in-app analytics, no telemetry, no tracking. Everything user-initiated and optional.

---

## Decision: Three Channels

### 1. Bug Reports → Form on pikos.app/bugs

**Why a form, not email:** Bugs need structure — steps to reproduce, OS version, app version, what happened vs. what was expected. Unstructured email bug reports are painful to triage. A form with guided fields gets usable reports from non-technical users.

**Implementation:**
- New page at `apps/marketing/src/pages/bugs.astro`
- Switch Astro to hybrid/server mode (SSR for form endpoints, static for everything else)
- Form fields:
  - What happened? (required, textarea)
  - Steps to reproduce (required, textarea)
  - What did you expect? (optional, textarea)
  - App version (auto-filled if linked from app, otherwise text input)
  - OS and version (text input)
  - Email (optional — "Only if you want to hear back about this bug")
- POST to an API route in Astro (`src/pages/api/bugs.ts`)
- API route writes to your home server DB (direct insert or forward to a lightweight API on the home server)
- Success page: "Got it. If you left your email, I'll follow up." Keep it personal.

**In the desktop app:**
- Add a "Report a Bug" link in the app's Help menu (or settings)
- Opens `pikos.app/bugs` in the default browser
- Optionally append query params: `?version=0.4.2&os=macos-14.3` so the form auto-fills those fields
- The app itself makes zero network requests — it just opens a URL

### 2. Feature Requests → Self-hosted Fider at feedback.pikos.app

**Why Fider:** Open-source feature request board with upvoting, exactly what you described. Docker image + Postgres, trivial to deploy on Coolify. Users can browse existing requests, upvote, and submit new ones. You get prioritization signal without having to ask.

**Key properties:**
- Self-hosted on your home server via Coolify — no third-party data sharing
- Subdomain: `feedback.pikos.app` (or `requests.pikos.app`)
- Anonymous posting supported (no account required to submit or upvote)
- Optional email for notifications on status changes ("We built this!")
- You moderate and respond as the admin
- Public board — users can see what others want, reduces duplicate requests
- Categories/tags for organization (notes, tasks, calendar, import/export, etc.)

**Fider setup:**
- Docker image: `getfider/fider`
- Needs: Postgres (already have on home server or spin up via Coolify), SMTP for optional notifications
- Custom branding to match pikos.app look
- Cloudflare DNS: CNAME `feedback.pikos.app` → home server

**In the desktop app:**
- "Request a Feature" link in Help menu / settings
- Opens `feedback.pikos.app` in browser

### 3. General Feedback → Email

**Why email:** General feedback ("I love this," "the calendar feels weird," "have you considered X") doesn't need structure. Email is zero-friction, personal, and fits the indie dev brand. A form for this would feel corporate.

**Implementation:**
- Pikos domain email: `hey@pikos.app` (or `alex@pikos.app`)
- "Send Feedback" link in the app opens `mailto:hey@pikos.app?subject=Pikos%20Feedback`
- Also listed on the marketing site footer and a `/contact` or `/feedback` page

---

## What NOT to do

- **No in-app forms or network requests.** The app stays offline. Links open in the browser. This is non-negotiable per the privacy pact.
- **No analytics/telemetry for usage patterns.** You learn what users want by what they tell you, not by watching them.
- **No required accounts on Fider.** Anonymous submissions must work. Optional email only for follow-up notifications.
- **No Plausible/analytics on the Fider board.** Keep it clean.

---

## Marketing Site Changes

### New pages

| Page | Purpose |
|------|---------|
| `/bugs` | Bug report form (SSR — needs Astro hybrid mode) |
| `/feedback` | Simple page with three options: report a bug, request a feature, send feedback. Links to `/bugs`, `feedback.pikos.app`, and `mailto:` respectively. |

### Astro SSR migration

The marketing site is currently static on Cloudflare Pages. To handle form submissions:

**Option A — Astro hybrid mode on Cloudflare:**
- Set `output: 'hybrid'` in astro config
- Use `@astrojs/cloudflare` adapter
- API route at `src/pages/api/bugs.ts` forwards to home server API
- Pro: keeps everything on Cloudflare, simple deployment
- Con: adds a dependency on Cloudflare Workers runtime for the API route

**Option B — Static site + separate API on home server:**
- Keep Astro fully static
- Bug form POSTs directly to `api.pikos.app/bugs` (home server)
- Pro: marketing site stays dead simple
- Con: CORS config, separate deployment, another subdomain

**Recommendation: Option A.** Cloudflare's free tier includes Workers. One deployment pipeline. The form handler is a thin proxy that forwards to your home server DB. Everything else stays static (use `export const prerender = true` on all existing pages).

### Footer update

Add to the marketing site footer:
```
Feedback · Bugs · Request a Feature
```

### Nav / help links in the desktop app

Add to settings or help menu:
- Report a Bug → `pikos.app/bugs?version={version}&os={os}`
- Request a Feature → `feedback.pikos.app`
- Send Feedback → `mailto:hey@pikos.app?subject=Pikos%20Feedback`

---

## Infrastructure

### Home server (Coolify)

| Service | Purpose | Stack |
|---------|---------|-------|
| Fider | Feature request board | Docker + Postgres |
| Bug report API | Receives bug form submissions | Lightweight API (Node/Go/whatever you prefer) or just a Postgres insert via Fider's API |

**Alternative to a separate bug API:** Fider supports different post types. You could use a single Fider instance with two boards — one for bugs, one for feature requests. This eliminates the need for a custom bug form entirely. Tradeoff: bug reports lose the structured fields (steps to reproduce, OS, version). For a solo dev with low initial volume, this might be fine — you can always split later if volume warrants it.

### DNS

```
pikos.app          → Cloudflare Pages (existing)
feedback.pikos.app → Home server (Coolify / Fider)
```

---

## Implementation Order

1. **Set up Pikos email** (`hey@pikos.app` or similar) — instant, no code
2. **Deploy Fider on Coolify** — Docker compose, Postgres, DNS, basic branding
3. **Add `/feedback` page to marketing site** — static page linking to all three channels
4. **Add `/bugs` form to marketing site** — requires Astro hybrid mode + API route
5. **Add help menu links in desktop app** — opens browser URLs, zero network requests from app
6. **Update marketing site footer** — add feedback/bugs links

Steps 1-3 can ship fast. Step 4 is the most work (Astro SSR migration + form + API). Step 5 is trivial once URLs are live.

---

## Open Questions

- **Subdomain preference:** `feedback.pikos.app` vs `requests.pikos.app` vs `board.pikos.app`?
- **Bug reports via Fider instead of custom form?** Simpler infra, less structured data. Fine at low volume.
- **Email provider for hey@pikos.app?** Fastmail, Migadu, Cloudflare Email Routing + forwarding, or self-hosted?
- **Do you want the Fider board to be fully public (anyone can browse) or submit-only?** Public is better for reducing duplicates and building community. But it also shows your hand on what you haven't built yet.
