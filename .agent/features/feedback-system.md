# Feedback System — Plan

## Problem

Need a way to capture bug reports, feature requests, and general feedback from users without violating the privacy-first positioning. No in-app analytics, no telemetry, no tracking. Everything user-initiated and optional.

---

## Decision: Three Channels

### 1. Bugs + Feature Requests → Self-hosted Fider at feedback.pikos.app

Single Fider instance handles both bugs and feature requests. Use Fider's tagging/categories to separate them (e.g., "Bug" and "Feature Request" tags). At current volume (friends beta → early launch), structured bug form fields aren't worth the infra complexity. If someone submits a vague bug report, follow up via email. Build a dedicated bug form later only if volume makes unstructured reports unmanageable.

**Key properties:**
- Self-hosted on home server via Coolify — no third-party data sharing
- Subdomain: `feedback.pikos.app`
- Fully public board — anyone can browse, upvote, and submit
- Anonymous posting supported (no account required to submit or upvote)
- Optional email for notifications on status changes ("We built this!")
- You moderate and respond as the admin
- Categories/tags: Bug, Feature Request, Notes, Tasks, Calendar, Import/Export, etc.

**Fider setup:**
- Docker image: `getfider/fider`
- Needs: Postgres (spin up via Coolify alongside Fider), SMTP for optional email notifications
- Custom branding to match pikos.app look (logo, colors)
- Cloudflare DNS: CNAME `feedback.pikos.app` → home server

**In the desktop app:**
- "Report a Bug" and "Request a Feature" links in Help menu / settings
- Both open `feedback.pikos.app` in the default browser
- App makes zero network requests — just opens a URL
- Optionally link bugs to a filtered view: `feedback.pikos.app?tags=bug`

### 2. General Feedback → Email

General feedback ("I love this," "the calendar feels weird," "have you considered X") doesn't need structure or a board. Email is zero-friction, personal, and fits the indie dev brand.

**Implementation:**
- Pikos domain email: `hey@pikos.app`
- "Send Feedback" link in the app opens `mailto:hey@pikos.app?subject=Pikos%20Feedback`
- Also listed on the marketing site footer and `/feedback` page

---

## What NOT to do

- **No in-app forms or network requests.** The app stays offline. Links open in the browser. Non-negotiable per the privacy pact.
- **No analytics/telemetry for usage patterns.** You learn what users want by what they tell you, not by watching them.
- **No required accounts on Fider.** Anonymous submissions must work. Optional email only for follow-up notifications.

---

## Marketing Site Changes

### New page

| Page | Purpose |
|------|---------|
| `/feedback` | Simple page with three paths: report a bug, request a feature, send feedback. Links to `feedback.pikos.app` (with appropriate tag filters) and `mailto:hey@pikos.app`. |

Marketing site stays fully static — no SSR migration needed. The `/feedback` page is just links to Fider and a mailto. No form handling required.

### Footer update

Add to the marketing site footer:
```
Feedback · Report a Bug · Request a Feature
```

### Help links in the desktop app

Add to settings or help menu:
- Report a Bug → `feedback.pikos.app` (tagged/filtered to bugs)
- Request a Feature → `feedback.pikos.app`
- Send Feedback → `mailto:hey@pikos.app?subject=Pikos%20Feedback`

---

## Infrastructure

### Home server (Coolify)

| Service | Purpose | Stack |
|---------|---------|-------|
| Fider | Bug reports + feature request board with upvoting | Docker + Postgres |

That's it. One service. Postgres runs as a companion container in the same Coolify stack.

### DNS

```
pikos.app          → Cloudflare Pages (existing)
feedback.pikos.app → Home server (Coolify / Fider)
```

### SMTP

Fider needs SMTP for optional email notifications (status change alerts, reply notifications). Options:
- Cloudflare Email Routing (free, if you're already using it for hey@pikos.app)
- Resend (free tier: 100 emails/day)
- Self-hosted on home server (more work, but no external dependency)

---

## Implementation Order

1. **Set up Pikos email** (`hey@pikos.app`) — Cloudflare Email Routing or provider of choice
2. **Deploy Fider on Coolify** — Docker compose with Postgres, DNS, SMTP config, branding
3. **Seed the board** — Create a few initial posts yourself (known feature ideas, known bugs) so it's not empty when users arrive
4. **Add `/feedback` page to marketing site** — static page linking to all three channels
5. **Update marketing site footer** — add feedback links
6. **Add help menu links in desktop app** — opens browser URLs, zero network requests from app

Steps 1-2 are the real work. Steps 3-6 are straightforward once Fider is live.

---

## Future considerations

- **Dedicated bug form:** If bug volume grows and unstructured reports become a triage bottleneck, add a structured form at `pikos.app/bugs` with guided fields (steps to reproduce, OS, version). This would require Astro hybrid mode or a separate API endpoint. Don't build this until the problem actually exists.
- **GitHub Issues integration:** When the repo goes public at Phase 3, technical users will file bugs on GitHub anyway. Fider can coexist — it serves the non-technical audience that won't touch GitHub.
