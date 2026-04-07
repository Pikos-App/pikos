# Cloudflare Email Routing → Fastmail

**Status: ✅ Complete (2026-04-06)**

`hello@pikos.app` receives via Cloudflare Email Routing (forwards to Fastmail) and sends via Fastmail identity with SPF/DKIM/DMARC configured.

## What Was Set Up

- **Inbound**: Cloudflare Email Routing forwards `hello@pikos.app` → `hello@alex-ak.com` (Fastmail). Destination auto-verified (same as Cloudflare account email).
- **Outbound**: Fastmail sending identity for `hello@pikos.app` (name: "Alex"). No authenticated SMTP — Fastmail sends through its own servers, authorized by DNS records.
- **Fastmail mail rule**: Incoming `hello@pikos.app` mail routes to a "Pikos" folder.
- **No catch-all** — only `hello@` is active.

## Key Decisions

- **No Fastmail domain registration**: Fastmail DKIM signs with `messagingengine.com`, not `pikos.app`. Domain-aligned DKIM would require adding `pikos.app` as a domain in Fastmail (Settings → Domains). Not needed for low-volume support email — SPF alignment is sufficient for DMARC pass.
- **DMARC `p=none`**: Monitor-only policy. Move to `p=quarantine` after confirming no delivery issues over time.

## DNS Records (Cloudflare, pikos.app)

| Type | Name | Content/Target | Purpose |
|------|------|----------------|---------|
| MX | `@` | `route1.mx.cloudflare.net` (pri 77) | Cloudflare Email Routing |
| MX | `@` | `route2.mx.cloudflare.net` (pri 34) | Cloudflare Email Routing |
| MX | `@` | `route3.mx.cloudflare.net` (pri 75) | Cloudflare Email Routing |
| TXT | `@` | `v=spf1 include:spf.messagingengine.com include:_spf.mx.cloudflare.net ~all` | SPF |
| TXT | `cf2024-1._domainkey` | Cloudflare DKIM key (auto-generated) | Cloudflare DKIM |
| CNAME | `fm1._domainkey` | `fm1.pikos.app.dkim.fmhosted.com` | Fastmail DKIM |
| CNAME | `fm2._domainkey` | `fm2.pikos.app.dkim.fmhosted.com` | Fastmail DKIM |
| CNAME | `fm3._domainkey` | `fm3.pikos.app.dkim.fmhosted.com` | Fastmail DKIM |
| TXT | `_dmarc` | `v=DMARC1; p=none; rua=mailto:hello@pikos.app` | DMARC |

## Verification (2026-04-06)

Test email sent from Fastmail as `hello@pikos.app`, headers confirmed:
- `spf=pass` — Fastmail authorized via `include:spf.messagingengine.com`
- `dmarc=pass` — policy evaluated, disposition=none
- `dkim=pass` — signed by `messagingengine.com` (Fastmail's key)

## Future Considerations

- **DMARC tightening**: Upgrade `p=none` → `p=quarantine` → `p=reject` once confident in deliverability
- **Domain-aligned DKIM**: Add `pikos.app` to Fastmail Domains if sending volume increases or stricter receivers reject `messagingengine.com`-signed mail
- **Catch-all**: Enable if additional addresses needed (e.g., `support@`, `alex@`)
