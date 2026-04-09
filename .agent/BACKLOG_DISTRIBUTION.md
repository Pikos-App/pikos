# Distribution & Publishing Backlog Tasks

> Tasks are ordered by dependency. Each task is tagged:
> - 🧑 = manual (portal clicks, decisions, purchases — you do this)
> - 🤖 = Claude Code can execute with the description as-is
> - 🧑🤖 = mixed (you provide credentials/decisions, Claude Code does the implementation)
>
> Phase mapping: tasks are grouped by when they should be done relative to your GTM phases.


## Completed (2026-04-08)

- Apple Developer enrollment, bundle ID registration (`app.pikos.desktop`), Developer ID Application cert
- GitHub Secrets configured: `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, `APPLE_API_KEY`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER_ID`, `TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`
- Apple code signing + notarization enabled in `release.yml`
- Tauri updater keypair generated, pubkey set in `tauri.conf.json`
- Release script: `pnpm release <major|minor|patch>` — bumps versions, commits, tags, pushes, prints CI link
- `/open` → `/source` rename across marketing site, GTM, backlogs
- `/source` page complete with lightbox video
- Feedback pages simplified (Fider deferred to post-launch)
- First signed release: v0.2.1 (in progress)

---

## Phase 2 (friends beta pipeline — private repo, direct distribution)

---

### GOO-52B: Tauri auto-updater — app-side integration 🤖

**What:** Keypair generated, pubkey in config, CI produces `.sig` files and `latest.json`. Still needed: implement the update check in the app.

**Remaining:**
1. Verify `@tauri-apps/plugin-updater` is installed and registered in Rust plugin builder
2. Add update check on app launch (silent fail if offline)
3. Test: install v0.2.1, push v0.2.2, verify update prompt appears

**Note:** Endpoint URL points to GitHub Releases — requires public repo to work for end users. Works for testing if you have repo access.

---

### GOO-52D: Test signed build on clean macOS install 🧑

**What:** Verify the full Gatekeeper experience before sending the beta to anyone.

**Steps:**
1. Download the `.dmg` from GitHub Releases (not from your build output — use the actual download URL).
2. Test on a different macOS user account, or ideally a different Mac entirely.
3. Mount the `.dmg`, drag to Applications, launch.
4. Verify: no Gatekeeper warning, no "unidentified developer" dialog, no quarantine issues.
5. If using Sequoia (macOS 15), verify the new notarization UX works correctly.
6. Verify the app icon appears correctly in the dock, Finder, and the DMG window.

**If Gatekeeper warns:** Check that notarization actually succeeded in the CI logs. Common issues: the stapling step failed silently, or the DMG was modified after notarization.

---

---

## Phase 3 (public launch — all ship together)

> Phase 3 is a single coordinated moment: repo goes public, `/download` page goes live, `/source` page goes live, blog posts publish. The repo must be public before `/download` works — GitHub Releases return 404 for unauthenticated requests on private repos.

---

### GOO-53-DL: Build /download page + Cloudflare Pages Function 🤖

**What:** Create a `/download` page on the marketing site with platform buttons, backed by a Cloudflare Pages Function that redirects to the latest GitHub Release asset.

**Prerequisites:** Repo is public. At least one GitHub Release exists with `.dmg`, `.AppImage`, and `.deb` artifacts.

**Implementation:**

1. **Cloudflare Pages Function** (`apps/marketing/functions/download/[platform].ts`):
   - `GET /download/mac` → 302 redirect to latest `.dmg` from GitHub Releases
   - `GET /download/linux` → 302 redirect to latest `.AppImage` from GitHub Releases
   - Hits GitHub API (`/repos/{owner}/{repo}/releases/latest`), finds asset by filename pattern
   - Cache the GitHub API response (5–10 min) to avoid rate limits
   - Returns 404 with a helpful message for unknown platforms

2. **Download page** (`apps/marketing/src/pages/download.astro`):
   - Two download buttons: "Download for Mac" (links to `/download/mac`), "Download for Linux" (links to `/download/linux`)
   - Show current version number (can be static, updated on release — or fetched client-side from GitHub API)
   - System requirements: macOS 11+ (Big Sur), Linux x86_64
   - Callout: "Want iCloud sync across devices? Coming soon to the Mac App Store."
   - Link to GitHub Releases for all versions / changelog

3. **Update homepage CTA** — "Download" button on `/` should link to `/download`.

**Acceptance criteria:**
- `/download/mac` redirects to a `.dmg` URL on `github.com/.../releases/...`
- `/download/linux` redirects to an `.AppImage` URL
- `/download` page renders with platform buttons
- Redirect works for unauthenticated users (repo must be public)
- Redirect resolves in <500ms (cached GitHub API response)

---

### GOO-XX: Make repo public 🧑

**What:** Flip the private monorepo to public (or set up the public mirror repo per GTM).

**Decision needed:** Single repo flip vs. separate public mirror synced by CI. Mirror is more work but keeps mobile code private when it exists. If mobile doesn't exist yet, flipping the existing repo is simpler.

**Must happen before `/download` page goes live** — GitHub Releases are inaccessible on private repos.

---


---

## Phase 4 (Mac App Store)

These tasks are sequenced for after public launch, when you're ready for MAS submission.

---

### GOO-MAS-1: Audit SQLite database location for sandbox compatibility 🤖

**What:** Determine whether the current database file location will survive App Sandbox restrictions, and implement migration if needed.

**Investigation steps:**
1. Find where Pikos currently writes its SQLite database. Check:
   - `tauri.conf.json` for any path config
   - Rust code in `src-tauri/` for database initialization (likely uses `app.path()` API)
   - `packages/core` for any hardcoded paths
2. Determine the current path at runtime (e.g., `~/Library/Application Support/app.pikos.desktop/` is typical for Tauri).
3. Check if this path falls within the App Sandbox container (`~/Library/Containers/<bundle-id>/Data/Library/Application Support/`).

**What needs to happen:**
- Under App Sandbox, Tauri's `app_data_dir()` should automatically resolve to the sandboxed container path. Verify this by building with sandbox entitlements locally.
- If the non-sandboxed app wrote the DB to `~/Library/Application Support/app.pikos.desktop/`, the sandboxed version won't have access to that location by default.
- **Migration path needed:** On first launch of the MAS version, detect if a database exists at the old (non-sandboxed) location. If so, copy it into the sandbox container. This handles the upgrade path from free direct-download to paid App Store version.

**Implementation:**
- Add a startup check in Rust that looks for the DB at the legacy path
- If found and no DB exists at the sandboxed path, copy it over
- Log the migration for debugging
- Never delete the old DB (user might switch back to the direct download version)

**Acceptance:** App works correctly under App Sandbox. Existing database from direct-download version is seamlessly picked up by the MAS version on first launch.

---

### GOO-MAS-2: Configure App Sandbox entitlements 🤖

**What:** Create and test the entitlements file needed for Mac App Store submission.

**Implementation:**
1. Create `apps/desktop/src-tauri/entitlements.plist` (or update if Tauri 2 has a default location):
   ```xml
   <?xml version="1.0" encoding="UTF-8"?>
   <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "...">
   <plist version="1.0">
   <dict>
     <key>com.apple.security.app-sandbox</key>
     <true/>
     <!-- File access: user-selected files via open/save dialogs -->
     <key>com.apple.security.files.user-selected.read-write</key>
     <true/>
     <!-- Network access: needed for auto-updater and future sync -->
     <key>com.apple.security.network.client</key>
     <true/>
   </dict>
   </plist>
   ```
2. Test locally: `codesign --entitlements entitlements.plist ...` and run the app.
3. Verify all functionality works:
   - SQLite database reads/writes
   - TipTap editor (WebView rendering)
   - Any file import/export features
   - Keyboard shortcuts (some can be restricted by sandbox)
4. Document any features that break and file follow-up tasks.

**Acceptance:** App launches and all core features work with App Sandbox enabled. No crashes, no permission dialogs that shouldn't be there.

---

### GOO-MAS-3: Generate Mac App Store signing certificates 🧑

**What:** Create the additional certificates needed for MAS distribution (separate from the Developer ID certs used for direct distribution).

**Steps:**
1. In Apple Developer portal → Certificates → create:
   - **Mac App Distribution** certificate (signs the app for MAS)
   - **Mac Installer Distribution** certificate (signs the `.pkg` installer for MAS upload)
2. Export both as `.p12`, base64-encode for CI secrets.
3. Add to GitHub Secrets:
   - `MAS_CERTIFICATE` — Mac App Distribution .p12 (base64)
   - `MAS_CERTIFICATE_PASSWORD`
   - `MAS_INSTALLER_CERTIFICATE` — Mac Installer Distribution .p12 (base64)
   - `MAS_INSTALLER_CERTIFICATE_PASSWORD`

---

### GOO-MAS-4: Add Mac App Store build target to CI 🧑🤖

**What:** Add a separate workflow (or matrix entry) that produces a MAS-signed `.pkg` ready for upload to App Store Connect.

**🧑 You do:** Add the MAS certificate secrets (from GOO-MAS-3).

**🤖 Claude Code implements:**
- New workflow or job in the release workflow: `.github/workflows/release-mas.yml` (or a `mas` entry in the matrix)
- Uses the MAS certificates instead of Developer ID certificates
- Applies the sandbox entitlements from GOO-MAS-2
- Produces a `.pkg` file (not `.dmg` — MAS requires `.pkg`)
- Does NOT upload to GitHub Releases (MAS builds go to App Store Connect, not public download)
- Either uploads to App Store Connect via `xcrun altool` / Transporter, or outputs the `.pkg` as a workflow artifact for manual upload

**Acceptance:** Workflow produces a `.pkg` that passes `xcrun altool --validate-app`.

---

### GOO-MAS-5: Prepare App Store metadata and privacy declarations 🧑

**What:** Prepare everything needed in App Store Connect before the first submission.

**In App Store Connect, create the app listing and fill in:**

1. **App name:** Pikos
2. **Subtitle:** "Notes, tasks, and calendar — private by default" (30 char limit, adjust to fit)
3. **Category:** Productivity
4. **Description:** Draft from your marketing site copy. Focus on the general user pitch, not technical details. App Store descriptions don't support markdown.
5. **Keywords:** `notes,tasks,calendar,local,private,productivity,offline,planner` (100 char limit, comma-separated, no spaces)
6. **Privacy nutrition labels:** This is a key selling point. Select "Data Not Collected" for all categories. Apple will ask you to confirm — this is accurate because Pikos has no analytics, no accounts, no server communication (in the MAS version, sync is via the user's own iCloud).
7. **Age rating:** Fill out the questionnaire. Pikos has no objectionable content — should qualify for 4+.
8. **Screenshots:** Required resolutions:
   - 6.5" display (1284 x 2778) — only if you ship iPhone app
   - 13" display (2880 x 1800 or 2560 x 1600) — for Mac
   - Take these from the actual app with real content, not mockups
9. **App preview video:** Optional but valuable. Reuse the demo video from Phase 3 launch if the format fits.
10. **Review notes:** Tell the reviewer: "This is a local-first productivity app. No account creation is required. All data is stored on-device." This preempts questions about why there's no login flow.

**Timeline:** ~1–2 hours to fill everything in. Have the screenshots ready before you start.

---

### GOO-MAS-6: Submit to Mac App Store and handle review 🧑

**What:** Upload the build and manage the review cycle.

**Steps:**
1. Upload the `.pkg` from GOO-MAS-4 via Transporter app or `xcrun altool`.
2. In App Store Connect, select the uploaded build, attach it to the app version, and submit for review.
3. Expect 24–48 hours for first review.

**Common rejection reasons for Tauri apps (prepare for these):**
- **Sandbox violation:** File access outside container. Should be caught by GOO-MAS-2 testing.
- **Missing privacy declarations:** If any framework Tauri bundles makes network calls you didn't declare.
- **Minimum functionality:** Apple sometimes rejects apps they consider "too simple." Unlikely for Pikos but have a response ready.
- **WebView restrictions:** Apple may flag the embedded WebView. Tauri uses WKWebView which is allowed, but the reviewer might not know that. Include a note explaining the architecture.

**Budget 2–3 rejection cycles.** Each is 24–48 hours. Total timeline from first submission to approval: 1–3 weeks.

---

## Deferred / conditional

---

### GOO-XX: Windows binary distribution 🧑

**What:** Add Windows builds to the release pipeline. Currently no Windows binary — unsigned `.msi` triggers SmartScreen warnings that look like malware to non-technical users.

**When:** Only if non-technical Windows demand materializes post-launch. Technical Windows users can build from source via the public repo.

**If you proceed:**
- Add Windows target to CI release matrix
- Purchase an OV code signing cert (~$300–500/yr from SSL.com or equivalent) — now requires hardware token or cloud signing
- Sign the `.msi`/`.exe` during the Windows build step
- SmartScreen reputation builds over time — first few hundred installs may still warn even with a valid cert
- Add Windows entry to `/download` page

**Decision point:** After Phase 3 launch, assess whether anyone is asking for Windows builds.

---

### GOO-XX: Homebrew cask submission 🤖

**What:** Create a Homebrew cask so technical users can install via `brew install --cask pikos`.

**When:** Phase 3, after the first stable public release.

**Implementation:**
- Create a cask formula (Ruby file) pointing at the GitHub Releases `.dmg` URL
- Submit a PR to `homebrew/homebrew-cask`
- Alternatively, maintain your own tap (`gooselabs/homebrew-tap`) for faster iteration

**Prerequisites:** Stable `.dmg` URL pattern, notarized builds.

**Claude Code can draft the cask formula once the release URL pattern is established.**

---

### GOO-XX: Updater UI component (post-beta) 🤖

**What:** Replace the native OS dialog updater with an in-app update notification.

**When:** After friends beta, when you have a settings modal or notification system.

**Implementation:**
- Add an unobtrusive notification bar or toast when an update is available (not a blocking modal)
- "Update available — restart to install" with a button
- Optional: "Check for updates" button in settings
- Background check on launch, max once per 24 hours
- Never block the app — if the update check fails, carry on silently

**This is low priority — the native dialog is fine for a long time.**