# Fider Setup on Coolify (Home Server)

Deploy Fider as the feature request board at `feedback.pikos.app`.

---

## 1. Prerequisites

- Coolify running on your home server
- A domain you control (`pikos.app`) with DNS on Cloudflare
- Home server accessible from the internet (port 443 at minimum — Coolify handles TLS)

## 2. DNS

In Cloudflare DNS for `pikos.app`:

| Type | Name | Target | Proxy |
|------|------|--------|-------|
| A | `feedback` | `<your-home-server-public-ip>` | DNS only (gray cloud) |

Use **DNS only** (not proxied) so Coolify can handle its own TLS via Let's Encrypt. If you want Cloudflare's proxy/CDN in front, set to proxied (orange cloud) and configure Coolify to skip TLS — Cloudflare terminates SSL instead.

If your home IP is dynamic, use a CNAME to a DDNS hostname instead.

## 3. Create the Fider service in Coolify

### Option A: Docker Compose (recommended)

In Coolify, create a new **Docker Compose** resource. Use this compose file:

```yaml
services:
  fider:
    image: getfider/fider:stable
    restart: unless-stopped
    ports:
      - "3000:3000"
    environment:
      BASE_URL: https://feedback.pikos.app
      DATABASE_URL: postgres://fider:${FIDER_DB_PASSWORD}@fider-db:5432/fider?sslmode=disable
      JWT_SECRET: ${FIDER_JWT_SECRET}
      EMAIL_NOREPLY: noreply@pikos.app
      # SMTP — pick one of the options below
      EMAIL_SMTP_HOST: ${SMTP_HOST}
      EMAIL_SMTP_PORT: ${SMTP_PORT}
      EMAIL_SMTP_USERNAME: ${SMTP_USERNAME}
      EMAIL_SMTP_PASSWORD: ${SMTP_PASSWORD}
      EMAIL_SMTP_ENABLE_STARTTLS: "true"
    depends_on:
      fider-db:
        condition: service_healthy

  fider-db:
    image: postgres:16-alpine
    restart: unless-stopped
    volumes:
      - fider-pg-data:/var/lib/postgresql/data
    environment:
      POSTGRES_USER: fider
      POSTGRES_PASSWORD: ${FIDER_DB_PASSWORD}
      POSTGRES_DB: fider
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U fider"]
      interval: 5s
      timeout: 3s
      retries: 5

volumes:
  fider-pg-data:
```

### Option B: Separate services

If you prefer to manage Postgres separately (or reuse an existing instance):

1. Create a Postgres database and user for Fider
2. Create a single Docker container in Coolify with image `getfider/fider:stable`
3. Set the environment variables pointing to your Postgres instance

## 4. Environment variables

Set these in Coolify's environment variable section:

| Variable | Value | Notes |
|----------|-------|-------|
| `FIDER_DB_PASSWORD` | Generate a strong random password | `openssl rand -base64 32` |
| `FIDER_JWT_SECRET` | Generate a strong random secret | `openssl rand -base64 48` |
| `SMTP_HOST` | Depends on provider (see below) | |
| `SMTP_PORT` | `587` (typically) | |
| `SMTP_USERNAME` | Depends on provider | |
| `SMTP_PASSWORD` | Depends on provider | |

### SMTP options

Fider needs SMTP to send email notifications (optional sign-in, status updates). Pick one:

**Resend (simplest):**
- Sign up at resend.com, verify `pikos.app` domain
- `SMTP_HOST`: `smtp.resend.com`
- `SMTP_PORT`: `587`
- `SMTP_USERNAME`: `resend`
- `SMTP_PASSWORD`: your Resend API key
- Free tier: 100 emails/day (more than enough)

**Fastmail (if you want everything in one place):**
- `SMTP_HOST`: `smtp.fastmail.com`
- `SMTP_PORT`: `587`
- `SMTP_USERNAME`: your Fastmail email
- `SMTP_PASSWORD`: generate an app-specific password in Fastmail settings
- Sends from your Fastmail account — emails come from `hello@pikos.app` if you've set up the identity

**Self-hosted (more work):**
- Run Mailpit or Postfix alongside Fider
- Only worth it if you already have a mail server running

## 5. Coolify domain configuration

1. In the Fider service settings in Coolify, set the **domain** to `feedback.pikos.app`
2. Enable **HTTPS** — Coolify provisions a Let's Encrypt certificate automatically
3. Set the container port to `3000`

## 6. Deploy and configure

1. Deploy the stack in Coolify
2. Visit `https://feedback.pikos.app` — Fider shows a first-run setup wizard
3. Create your admin account
4. Set the site name: **Pikos** (or "Pikos Feedback")

### Initial configuration

**After first login as admin:**

1. **Site Settings** → **General**
   - Site name: `Pikos`
   - Invitation: `Open` (anyone can post)
   - Logo: upload the Pikos logo

2. **Site Settings** → **Tags** — create these tags:
   - `Notes`
   - `Tasks`
   - `Calendar`
   - `Import / Export`
   - `UI / UX`
   - `Performance`

3. **Seed posts** — create 3-5 feature requests you already know about so the board isn't empty when users arrive. Examples:
   - "Day view for calendar"
   - "Wikilinks between pages"
   - "CalDAV sync"
   - "Split view / side-by-side editing"
   - "Tags page / tag browser"

## 7. Branding

Fider supports basic branding:

- **Logo:** upload via admin settings
- **Custom CSS:** Site Settings → Custom CSS. Match the pikos.app look:

```css
/* Match pikos.app orange accent */
:root {
  --color-primary: #f97316;
}
```

Fider's branding is limited. Don't spend too long — functional is fine.

## 8. Backups

The Postgres volume (`fider-pg-data`) contains all data. Back it up:

```bash
# From the host, dump the Fider database
docker exec fider-db pg_dump -U fider fider > /path/to/backups/fider-$(date +%Y%m%d).sql
```

Set up a cron job on your home server:

```bash
# Daily backup at 3am
0 3 * * * docker exec fider-db pg_dump -U fider fider | gzip > /backups/fider-$(date +\%Y\%m\%d).sql.gz
```

## 9. Verification checklist

- [ ] `feedback.pikos.app` loads with valid HTTPS
- [ ] Can create a post without signing in (anonymous)
- [ ] Can upvote without signing in
- [ ] Email notifications work (submit something, check for confirmation)
- [ ] Admin can add tags and moderate posts
- [ ] Logo and basic branding applied
- [ ] Database backup cron running
