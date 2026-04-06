# Cloudflare Email Routing → Fastmail

Set up `hello@pikos.app` to forward to your Fastmail inbox, and configure Fastmail to send as `hello@pikos.app`.

---

## 1. Enable Cloudflare Email Routing

1. Cloudflare dashboard → select `pikos.app` → **Email** → **Email Routing**
2. Click **Enable Email Routing** if not already enabled
3. Cloudflare will add the required MX and TXT records automatically — accept them

## 2. Create the routing rule

1. **Email Routing** → **Routing Rules** tab
2. Click **Create address**
3. **Custom address:** `hello`
4. **Destination:** your Fastmail email address (e.g., `alex@fastmail.com`)
5. Save

First time: Cloudflare sends a verification email to the Fastmail address. Click the link.

Emails to `hello@pikos.app` now land in your Fastmail inbox.

## 3. Catch-all (optional)

If you want `anything@pikos.app` to forward:

1. **Email Routing** → **Routing Rules** → **Catch-all address**
2. Set action to **Send to** → your Fastmail address

Skip this if you only want `hello@` active.

## 4. Send as `hello@pikos.app` from Fastmail

Without this, replies come from your Fastmail address, not `hello@pikos.app`.

### Add the sending identity in Fastmail

1. Fastmail → **Settings** → **Identities**
2. Click **New Identity**
3. **Name:** Alex (or whatever you want)
4. **Email:** `hello@pikos.app`
5. Save — Fastmail sends a verification email to `hello@pikos.app`, which forwards to your inbox. Click the link.

### Add DNS records for Fastmail sending

Fastmail needs SPF and DKIM records so emails from `hello@pikos.app` don't land in spam.

In **Cloudflare DNS** for `pikos.app`:

**SPF** — edit the existing TXT record for `pikos.app` (Cloudflare Email Routing already added one). Merge Fastmail's include:

```
v=spf1 include:spf.messagingengine.com include:_spf.mx.cloudflare.net ~all
```

If no existing SPF record, create:
- Type: `TXT`
- Name: `@`
- Content: `v=spf1 include:spf.messagingengine.com include:_spf.mx.cloudflare.net ~all`

**DKIM** — add three CNAME records:

| Type | Name | Target |
|------|------|--------|
| CNAME | `fm1._domainkey` | `fm1.pikos.app.dkim.fmhosted.com` |
| CNAME | `fm2._domainkey` | `fm2.pikos.app.dkim.fmhosted.com` |
| CNAME | `fm3._domainkey` | `fm3.pikos.app.dkim.fmhosted.com` |

**DMARC** (recommended):
- Type: `TXT`
- Name: `_dmarc`
- Content: `v=DMARC1; p=none; rua=mailto:hello@pikos.app`

Start with `p=none` (monitor only). Move to `p=quarantine` after confirming everything works.

### Verify

1. Send a test email from Fastmail using the `hello@pikos.app` identity
2. Check headers — should show `dkim=pass`, `spf=pass`
3. Use [mail-tester.com](https://www.mail-tester.com) to verify deliverability

## 5. DNS record summary

After setup, your DNS for `pikos.app` should include:

| Type | Name | Content/Target | Purpose |
|------|------|----------------|---------|
| MX | `@` | `isaac.mx.cloudflare.net` (pri 84) | Cloudflare Email Routing |
| MX | `@` | `linda.mx.cloudflare.net` (pri 6) | Cloudflare Email Routing |
| TXT | `@` | `v=spf1 include:spf.messagingengine.com include:_spf.mx.cloudflare.net ~all` | SPF |
| CNAME | `fm1._domainkey` | `fm1.pikos.app.dkim.fmhosted.com` | DKIM |
| CNAME | `fm2._domainkey` | `fm2.pikos.app.dkim.fmhosted.com` | DKIM |
| CNAME | `fm3._domainkey` | `fm3.pikos.app.dkim.fmhosted.com` | DKIM |
| TXT | `_dmarc` | `v=DMARC1; p=none; rua=mailto:hello@pikos.app` | DMARC |

Note: Cloudflare's exact MX hostnames may differ — use whatever Cloudflare provides during Email Routing setup.
