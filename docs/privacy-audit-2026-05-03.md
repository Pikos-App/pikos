# Pikos Privacy Compliance Audit — 2026-05-03

Working document. Findings to seed follow-up tickets and the privacy policy
draft.

Repo state at audit:

- App: `apps/desktop`, version `0.2.2`, identifier `app.pikos.desktop`.
- Branch: `claude/privacy-compliance-audit-J7VZu`.

In this pass we (a) lifted "Delete All Data" from Developer Tools to General →
Danger Zone, (b) audited the four outbound/logging surfaces below.

---

## Auto-updater

### What we found

- **Endpoint:** `https://github.com/pikos-app/pikos/releases/latest/download/latest.json`
  (`apps/desktop/src-tauri/tauri.conf.json:39`).
  Pikos uses **GitHub Releases as the update host** — there is no
  Coolify-hosted update endpoint. The "Coolify infra" assumption in the audit
  brief does not match what's deployed.
- **Plugin:** `tauri-plugin-updater` v2 (`Cargo.toml:28`,
  `package.json:36`). Public key for signature verification is configured
  (`tauri.conf.json:37`).
- **Frontend wiring:** `apps/desktop/src/shared/hooks/useAutoUpdater.ts`. One
  check on mount, no recurring polling, manual re-check from Settings →
  About. Skipped versions persist in `pikos:skippedVersion` localStorage.
- **What's sent in the request:** Standard `GET` to the JSON manifest URL.
  The plugin sends only the default headers (User-Agent in the form
  `tauri-plugin-updater/<version>`, `Accept`). No machine ID, install UUID,
  app-version query parameters, or auth headers — the configured URL contains
  no template substitutions (`{{target}}`, `{{arch}}`, `{{current_version}}`).
  Body is empty.
- **What the update server logs:** Out of our control. GitHub operates the
  endpoint and applies its own logging and retention policies. We do not run
  Coolify, Caddy, nginx, or Traefik in front of it.
- **What flows into our error logs:**
  `useAutoUpdater.ts:78` and `:102` log only `e.name` (the error class), not
  the error message — so updater errors that may include the response URL or
  body do not land in `pikos.log`.

### Privacy assessment

Update checks unavoidably expose the user's IP address and User-Agent to
GitHub, which under GDPR is personal data. Because GitHub is the data
controller for that endpoint:

- We are **not the controller** for what GitHub logs about update fetches.
- GitHub's privacy notice is the operative document for that traffic.
- We avoid the broader recommendation in the audit brief (turn off access
  logs, set 7–14 day rotation): there is no log we can rotate.

### Recommendation

- **Privacy policy:** disclose that update checks hit `github.com` and link
  to GitHub's privacy notice. Mention IP + User-Agent are observable to
  GitHub.
- **Opt-out:** the only update-related preference today is
  `pikos:skippedVersion` (`AppSettingsContext.tsx:66`) — and it only
  suppresses the *prompt* for one specific version. The network check
  itself still fires on every launch, so it does not solve the privacy
  concern (IP + UA are still exposed to GitHub even after a user "skips"
  an update). A genuine global opt-out (`pikos:autoUpdateEnabled`,
  default true, gating the `check()` call in `useAutoUpdater.ts:51`)
  remains a follow-up.
- **No infrastructure change required** — update host is GitHub.

Status: documented; no code change in this pass.

---

## Local logging

### What we found

**Where logs live**

- macOS: `~/Library/Logs/app.pikos.desktop/pikos.log`
- Linux: `~/.local/share/app.pikos.desktop/logs/pikos.log` (XDG default for
  `tauri-plugin-log`)
- Windows: `%LOCALAPPDATA%\app.pikos.desktop\logs\pikos.log`
- Identifier: `app.pikos.desktop` (`tauri.conf.json:5`).

**Rotation and retention**

- `apps/desktop/src-tauri/src/lib.rs:95-97`:
  - `max_file_size(2 * 1024 * 1024)` — 2 MB cap per file.
  - `RotationStrategy::KeepOne` — when the cap is hit, the file is rotated
    and only the most recent file is kept. Logs do not grow unbounded and
    naturally age out.
  - `TimezoneStrategy::UseUtc` — timestamps are UTC, no timezone fingerprint.
- This rotation policy is healthier than the audit brief assumed; no
  age-based config needed.

**Severity routing (`lib.rs:65-94`)**

- App logs (`pkos_lib`, `webview` targets) at INFO in release; DEBUG in dev
  or with `PIKOS_LOG_VERBOSE=1`.
- Dependency logs (sqlx, tao, wry) at WARN in release; this is what keeps
  per-query SQL out of `pikos.log`.
- Panic hook target always at ERROR (`lib.rs:94`).

**Logging policy**

- `apps/desktop/src/shared/logger.ts:1-56` is a long, strict policy comment.
  It says: log lifecycle anchors and destructive actions; don't log keystrokes
  or per-event noise; **don't log user content (page text, titles, search
  queries, file paths)**; for foreign-system errors that may echo user input,
  pass `e.name` not `e`.
- The frontend logger scrubs home-dir paths with the
  `HOME_PATH_RE` regex (`logger.ts:62`) before writing — covers macOS, Linux,
  Windows.
- The Rust panic hook logs only `panicked at <file>:<line>: <msg>` and does
  not capture a backtrace, so `RUST_BACKTRACE` traces from the build host
  cannot leak through panics (`lib.rs:45-58`).

**What actually gets logged (full inventory)**

Rust:

| Site | Level | Sample | Contains PII? |
| --- | --- | --- | --- |
| `lib.rs:113` | info | `=== Pikos 0.2.2 starting on macos ===` | No |
| `lib.rs:57` | error | `panicked at db/dev.rs:218: pool poisoned` | No (file:line is compile-time, see below) |
| `db/mod.rs:127` | info | `DB connected, migrations applied` | No |
| `db/mod.rs:156` | info | `Backfilled content_text for 4 pages` | No (count) |
| `db/dev.rs:247` | info | `reset_db: deleted 12 pages, 3 folders, 5 schedules, 1 recurrence rules, 0 focus sessions` | No (counts) |
| `db/dev.rs:347` | info | `export_json: 12 pages, 3 folders → ~/Downloads/pikos-export-2026-05-03T14-30-00.json` | No — `~`-stripped |
| `db/dev.rs:371` | info | `backup_db: wrote to ~/Downloads/pikos-backup-2026-05-03T14-30-00.sqlite` | No — `~`-stripped |
| `db/dev.rs:511` | warn | `export_markdown: failed to copy asset (NotFound)` | No (only `io::ErrorKind`) |
| `db/dev.rs:597` | info | `export_markdown: 12 pages, 4 assets → ~/Downloads/pikos-markdown-…` | No |
| `db/dev.rs:704` | info | `export_csv: 12 pages → ~/Downloads/…` | No |
| `notifications/scheduler.rs:135` | info | `Notification scheduler started` | No |
| `notifications/scheduler.rs:140` | warn | `Notification permission request failed: <e>` | OS error string — not user-derived |
| `notifications/scheduler.rs:154` | warn | `Scheduler tick failed: <e>` | DB error string — not user-derived |

TypeScript (all routed through `createLogger(scope)` → `tauri-plugin-log`):

| Site | Level | Sample | Contains PII? |
| --- | --- | --- | --- |
| `useAutoUpdater.ts:47,54,65,87,98` | info | `[AutoUpdater] Update available: 0.3.0` | No (version string) |
| `useAutoUpdater.ts:78,102` | error | `[AutoUpdater] Update check failed | RequestError` | No — only `e.name` |
| `WorkspaceContext.tsx:379,447` | info | `[WorkspaceContext] Workspace loaded (id=<uuid>)` | No (random UUID, not user identifier) |
| `WorkspaceContext.tsx:382,450` | error | `[WorkspaceContext] auto-init failed | <formatted error>` | Path-scrubbed; risk if SQLite echoes user input (low — UUID-keyed) |
| `WorkspaceContext.tsx:433` | info | `[WorkspaceContext] Tutorial seed planted` | No |
| `ThemeContext.tsx:100` | debug | `[ThemeContext] Applied theme on mount: mode=system resolved=dark` | No (preference) |
| `TauriSQLiteAdapter.ts:69` | error | `[TauriSQLiteAdapter] "list_pages" fired 51× in 1000ms — likely render-loop bug` | No — command name only, no params |
| `NotificationSettings.tsx:75,90` | warn/error | `[NotificationSettings] checkPermission failed | TypeError` | No — `e.name` |
| `NotificationSettings.tsx:85` | info | `[NotificationSettings] Permission request: granted` | No |
| `PikosImage.ts:65,229` | error | `[PikosImage] Failed to save asset | TauriError` | No — `e.name` |
| `imageDropBridge.ts:42,82` | error/warn | `[imageDropBridge] save_asset failed | TauriError` | No — `e.name` |
| `LinkPopover.tsx:247` | warn | `[LinkPopover] clipboard write failed | <err>` | Low risk |
| `SearchPalette.tsx:146` | error | `[SearchPalette] search failed | TauriError` | No — `e.name` (search query NOT logged) |
| `GeneralSettings.tsx:70` | warn | `[GeneralSettings] clipboard write failed | <err>` | Low |
| `GeneralSettings.tsx:157` | error | `[GeneralSettings] deleteAllData failed | <formatted error>` | Path-scrubbed |
| `keyboard/registry.ts:147,187` | error/warn | Combo names + binding ids — no user content | No |
| `ErrorBoundary.tsx:27` | error | `[Global] Render error in <componentStack> | <error>` | Path-scrubbed; could include component prop names if React puts them in the stack — low risk |
| Global handlers `logger.ts:141,145` | error | `[Global] Uncaught exception | <error>` and `Unhandled promise rejection | <reason>` | Path-scrubbed; **highest residual risk** — see below |

**Redacted sample of a typical session log**

```
[2026-05-03][14:21:08][pkos_lib][INFO] === Pikos 0.2.2 starting on macos ===
[2026-05-03][14:21:08][pkos_lib][INFO] DB connected, migrations applied
[2026-05-03][14:21:08][webview][INFO] [WorkspaceContext] Workspace loaded (id=8f1c9d7e-…)
[2026-05-03][14:21:08][pkos_lib][INFO] Notification scheduler started
[2026-05-03][14:21:08][webview][INFO] [AutoUpdater] Checking for updates
[2026-05-03][14:21:08][webview][DEBUG] [ThemeContext] Applied theme on mount: mode=system resolved=dark
[2026-05-03][14:21:09][webview][INFO] [AutoUpdater] Up to date
[2026-05-03][14:23:14][webview][ERROR] [SearchPalette] search failed | TauriError
[2026-05-03][14:25:03][pkos_lib][INFO] export_json: 24 pages, 4 folders → ~/Downloads/pikos-export-2026-05-03T14-25-03.json
```

### Privacy assessment

Logging discipline is solid. The policy is documented in code, the scrubber
is in place, and most callsites correctly use `e.name` to keep foreign error
strings out of the file. Two residual concerns:

1. **Global handlers** (`logger.ts:140-146`) pass the full `event.error` /
   `event.reason` to `formatError`. Path scrubbing applies, but if a
   third-party library throws an Error whose `.message` contains user input
   (e.g. a JSON parse error citing the bad input), it will reach disk.
2. **Panic file:line strings** (`lib.rs:55`) are encoded at compile time. If
   release builds aren't compiled with `--remap-path-prefix`, the log can
   include the build host's home path (e.g. `/Users/aking/pikos/...`). Not
   strictly user PII, but a build-host privacy leak.

### Recommendations

- **Larger:** add a pre-formatter to global handlers (`logger.ts`) that
  truncates `event.error.message` to ~200 chars before logging, so a runaway
  third-party error can't dump user input across multiple lines. Document
  as a follow-up ticket.
- **Larger:** add `--remap-path-prefix` to the release build (`Cargo.toml`
  `[profile.release]`) so panic locations don't include the maintainer's
  home directory. Build-config change; document as a follow-up.
- **Quick:** none required. Rotation, redaction policy, and the per-callsite
  `e.name` discipline are already in place.

Status: documented; no code change in this pass. Existing posture passes
muster for launch.

---

## Log sending

### What we found

There is **no in-app log-sending feature**. Bug reporting flows through:

1. **"Report a bug…" button** (`GeneralSettings.tsx:418-435`):
   - Opens `https://pikos.app/bugs?os={os}&version={__APP_VERSION__}` in
     the user's system browser via `tauri-plugin-opener`.
   - The Pikos app does not transmit anything itself; the user's browser
     loads the URL with `os` and `version` query parameters.
2. **Help → Report a Bug…** native menu item (`lib.rs:215-246`):
   - Same URL, same behaviour, called from the Tauri menu instead.
3. **`hello@pikos.app`** displayed for users to email (`GeneralSettings.tsx:60-75`).
   The app copies the address to the clipboard; it does not compose or send
   email.

The logger comment (`logger.ts:9-10`) says "Logs exist to reconstruct a
user's session from a bug report" — implying that if a user emails us with
a bug, we'd ask them to manually attach the file from
`~/Library/Logs/app.pikos.desktop/pikos.log`. There is no automated path.

### Privacy assessment

Today's posture is privacy-positive: logs never leave the device unless the
user manually attaches them to an email. No preview problem to solve because
no automated transmission exists.

### Recommendation

- **Hard requirement before any future "Send Logs" UI ships:** the feature
  MUST include a preview step. Specifically:
  - Before sending, display the full log contents in a scrollable monospace
    panel.
  - Display, in the same dialog, anything else that would be bundled (app
    version, OS version, workspace ID, etc.). Nothing auto-attached should
    be hidden from the user.
  - Provide explicit "Send" and "Cancel" buttons. No background submission.
  - Consider letting the user redact lines inline before sending.
- Document this in `apps/desktop/src/shared/logger.ts` near the top of the
  policy comment, so the constraint travels with the code rather than this
  audit doc.

Status: feature does not exist; preview requirement documented above as a
prerequisite for future implementation. No code change in this pass.

---

## Outbound network surface

Exhaustive grep across `apps/desktop/src` and `apps/desktop/src-tauri/src`
for `fetch(`, `axios`, `XMLHttpRequest`, `WebSocket`, `EventSource`,
`navigator.sendBeacon`, `reqwest`, `hyper`, `tauri::http`, `http::Client`.

### Inventory

| # | Site | Destination | Purpose | Expected? |
| --- | --- | --- | --- | --- |
| 1 | `tauri.conf.json:36-41` (plugin-updater) | `https://github.com/pikos-app/pikos/releases/latest/download/latest.json` | Auto-update manifest fetch | Yes (audited above) |
| 2 | `useAutoUpdater.ts:97` (`update.downloadAndInstall()`) | The signed binary URL listed inside the manifest above. Today this resolves to `https://github.com/pikos-app/pikos/releases/download/...` | Download installer when user accepts an update | Yes |
| 3 | `lib.rs:147` (`AboutMetadataBuilder.website`) | `https://pikos.app` | Native macOS About panel "Visit Website" link | Yes (opens in browser, app doesn't fetch) |
| 4 | `lib.rs:237` (`open_url`) | `https://pikos.app/faq` | Help → Pikos FAQ menu item | Yes (browser, not app) |
| 5 | `lib.rs:241-246` (`open_url`) | `https://pikos.app/bugs?os=…&version=…` | Help → Report a Bug menu item | Yes (browser, not app) |
| 6 | `GeneralSettings.tsx:184` (`openUrl`) | `https://pikos.app` | Settings → About → Website button | Yes (browser, not app) |
| 7 | `GeneralSettings.tsx:190` (`openUrl`) | `https://pikos.app/release-notes` | Settings → About → Release Notes button | Yes (browser, not app) |
| 8 | `GeneralSettings.tsx:425-427` (`openUrl`) | `https://pikos.app/bugs?os=…&version=…` | Settings → Feedback → Report a bug button | Yes (browser, not app) |

### Sites that look like network calls but are not

- `markdown.rs:466-550` — `https://example.com` and `http://asset.localhost/...`
  appear in **test fixture strings**, never executed.
- `http://asset.localhost/...` — Tauri's local asset protocol convention. The
  WebView intercepts this scheme and reads the file from disk; no network.
- `new URLSearchParams({…})` (`GeneralSettings.tsx:426`) — string builder
  for the bug-report query params. Not a fetch.

### Permissions sanity check

`apps/desktop/src-tauri/capabilities/default.json` does **not** grant
`http:default` or any `tauri-plugin-http` permission. Even if a contributor
adds a `fetch()` call, Tauri's permission model would block it at runtime.
That's a structural backstop on top of the code review.

### Privacy assessment

The only outbound IPC originated **from the Pikos process** is the GitHub
auto-updater (entries 1 and 2). Entries 3–8 are browser-handoffs via
`tauri-plugin-opener`: the app passes a URL string to the OS, which opens
the user's default browser. Pikos does not see the response and is not the
controller for that traffic — the browser is.

No telemetry. No analytics. No Sentry/Crashlytics. No Mixpanel, Amplitude,
PostHog, Segment. No background sync. No cloud database. No remote feature
flags. No A/B testing endpoint. None of these dependencies are in
`package.json`.

### Recommendation

- **No code change required.** The surface matches the local-first claim.
- For the privacy policy, the disclosure is short:
  - "Pikos checks for updates by requesting a JSON manifest from
    `github.com`. This unavoidably exposes your IP address and User-Agent
    to GitHub."
  - "Pikos opens links to `pikos.app` (website, FAQ, release notes, bug
    reporting) in your system browser when you click them. Pikos itself
    does not load these pages."

Status: documented; no code change in this pass.

---

## Summary of fixes applied in this pass

- **Lifted "Delete All Data" from Developer Tools to General → Danger
  Zone.** Behaviour: a new Rust command `wipe_app_data` drops the DB pool,
  recursively removes `app_data_dir` (SQLite DB + WAL + SHM, workspace
  assets, backups, `workspaces.json`) and `app_log_dir` (the rotating
  `pikos.log`). The frontend then clears `pikos:*` localStorage keys and
  calls `relaunch()` for a hard process restart. The app boots as if newly
  installed.
- **Generalised the toast surface** (`Toast.tsx`) so non-reversible notices
  no longer co-opt the "undo" wording.
- **Added `ConfirmDialog`** wrapper to deduplicate destructive AlertDialog
  use across General → Danger Zone and Developer → Seed scenarios.

### Recommendations queued as follow-ups

Each item below is sized so a future session can pick it up without
re-doing the investigation. Files cited are pinned to the commit at the
top of this audit; line numbers may drift.

#### 1. Genuine update opt-out (S, ~1 hr)

**Why:** Today the `check()` call in `useAutoUpdater.ts:51` fires on every
launch. `skippedVersion` only suppresses the *prompt* — the network round
trip to GitHub still happens, exposing IP + User-Agent. Privacy-conscious
users have no escape short of an air-gapped network.

**Where:**
- `apps/desktop/src/shared/context/AppSettingsContext.tsx` — add
  `autoUpdateEnabled: boolean` (default `true`), keyed
  `pikos:autoUpdateEnabled`. Mirror the `skippedVersion` plumbing.
- `apps/desktop/src/shared/hooks/useAutoUpdater.ts:43-51` — guard `doCheck()`
  with `if (!autoUpdateEnabled) return;` *before* the dynamic import.
- `apps/desktop/src/features/settings/components/GeneralSettings.tsx` —
  add a toggle in the "About" section (next to the "Checking for
  updates…" status), label "Check for updates automatically".

**Acceptance:** with the toggle off, `useAutoUpdater` never imports
`@tauri-apps/plugin-updater` and no network request is issued on launch
(verify in Tauri devtools network tab). Manual re-check button stays
functional regardless of the toggle.

#### 2. Bound global error message length (S, ~30 min)

**Why:** `logger.ts:140-146` passes the full `event.error` /
`event.reason` to `formatError()`. Path scrubbing applies but if a
third-party library throws an Error whose `.message` contains user input
(e.g. a JSON parser citing the bad input), it lands in `pikos.log`
unbounded.

**Where:**
- `apps/desktop/src/shared/logger.ts:68-81` — add a length cap to
  `formatError()`. After scrubbing, truncate to ~200 chars with an
  ellipsis if longer. Apply to both `e.message` and `e.stack`.

**Acceptance:** unit test for `formatError()` confirming a 1 KB error
message is truncated. No callsite-level changes needed; the cap applies
everywhere via the shared formatter.

#### 3. Strip build-host paths from panic locations (XS, ~10 min)

**Why:** `lib.rs:55` formats `info.location()` which Rust resolves to the
absolute source path encoded at compile time. Without `--remap-path-prefix`,
release builds compiled on a maintainer workstation embed e.g.
`/Users/aking/dev/pikos/...` strings into every panic log.

**Where:**
- `apps/desktop/src-tauri/Cargo.toml` — add to `[profile.release]`:

  ```
  [profile.release]
  rustflags = ["--remap-path-prefix", "/Users/=", "--remap-path-prefix", "/home/="]
  ```

  Or use the more portable `RUSTFLAGS` env var in the release script
  (`scripts/release.sh`).

**Acceptance:** `cargo build --release` followed by `strings target/release/pikos | grep -c '/Users/'` returns 0.

#### 4. Lock in the "preview before send" requirement (XS, ~10 min)

**Why:** No log-send feature exists today. We don't want a future session
to add one without realising the audit forbids automated submission.

**Where:**
- `apps/desktop/src/shared/logger.ts:1-56` — append to the policy comment:

  > **If a log-send feature is ever added, it MUST display the full log
  > and any auto-bundled metadata (app/OS version, etc.) in a scrollable
  > preview with explicit Send / Cancel before transmission. No
  > background submission. No silent metadata. See
  > `docs/privacy-audit-2026-05-03.md` §"Log sending".**

**Acceptance:** comment in place. No code change.

#### 5. Privacy policy copy (M, ~2 hr — content + review)

**Why:** Public launch needs a privacy notice. The audit gives us the
factual disclosures.

**Where:** marketing/legal repo or wherever the policy lives. Owner is
likely outside the desktop codebase.

**Content:**
- "Pikos stores all your data locally on your device. We have no servers
  that store your notes, tasks, or any other content."
- "Pikos checks for software updates by requesting a JSON manifest from
  GitHub Releases (`github.com`). This unavoidably exposes your IP
  address and User-Agent to GitHub. We do not run or have access to
  GitHub's logs. See [GitHub's privacy notice]."
- "When you click links inside Pikos (Website, FAQ, Release Notes,
  Report a Bug), the app passes the URL to your system browser. Pikos
  itself does not load these pages."
- "Pikos writes diagnostic logs to a rotating file on your device
  (capped at 2 MB, oldest content overwritten). Logs never leave your
  device unless you manually attach them to a bug report email. Pikos
  does not run analytics, crash reporting, telemetry, or A/B testing of
  any kind."
- "You can permanently delete every byte Pikos has stored about you
  (database, assets, logs, preferences) via Settings → General → Danger
  Zone → Delete All Data."

**Acceptance:** copy approved by Alex; published before the public
launch announcement.
