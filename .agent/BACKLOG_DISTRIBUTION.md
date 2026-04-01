# Distribution & Publishing Backlog Tasks

> Tasks are ordered by dependency. Each task is tagged:
> - 🧑 = manual (portal clicks, decisions, purchases — you do this)
> - 🤖 = Claude Code can execute with the description as-is
> - 🧑🤖 = mixed (you provide credentials/decisions, Claude Code does the implementation)
>
> Phase mapping: tasks are grouped by when they should be done relative to your GTM phases.


### GOO-XX: Enroll in Apple Developer Program 🧑

**What:** Enroll at https://developer.apple.com/programs/ ($99/yr). This is the gating dependency for all signing, notarization, and App Store work.

**Steps:**
1. Enroll as an Individual (not Organization — you're a solo dev, org enrollment requires a DUNS number and takes weeks).
2. Use your existing Apple ID. If the account has any outstanding issues (expired payment method, pending agreements), resolve them first — enrollment will silently fail otherwise.
3. Enrollment usually approves in 24–48 hours. Sometimes instant.
4. Once approved, accept all agreements in App Store Connect (https://appstoreconnect.apple.com) — there are usually 2–3 initial agreements.

**Outputs needed for downstream tasks:**
- Team ID (visible in Membership details)
- An App Store Connect API Key: go to Users & Access → Integrations → App Store Connect API → generate a key with "Developer" role. Download the `.p8` file — you only get one download.

**Store securely (you'll need these for GitHub Secrets):**
- Team ID
- API Key ID
- API Key Issuer ID
- The `.p8` file contents

**Timeline:** ~30 minutes of active work + 24–48hr wait for approval.

---

### GOO-XX: Register Bundle Identifier 🧑

**What:** Register the app's bundle ID in the Apple Developer portal. Signing and notarization won't work without this.

**Steps:**
1. Go to Certificates, Identifiers & Profiles → Identifiers → Register a new identifier.
2. Select "App IDs" → "App".
3. Set the Bundle ID to match what's in your `tauri.conf.json` under `identifier` (likely something like `app.pikos.desktop` or `com.gooselabs.pikos` — check your config and decide now if you want to change it, because changing it later is painful).
4. Enable capabilities you need: currently none beyond defaults. When you add App Sandbox for MAS, you'll come back here.

**Decision needed:** Confirm the bundle identifier string. This should match across `tauri.conf.json`, the Apple portal, and eventually the App Store listing. Recommend `app.pikos.desktop` to match the domain and leave room for `app.pikos.mobile` later.

**Timeline:** 5 minutes.

---

### GOO-XX: Generate macOS code signing certificates 🧑

**What:** Create the certificates needed for signing. You need two types, but only the first is required now.

**Certificates to create:**
1. **Developer ID Application** — required for direct distribution (notarized .dmg from your site / GitHub Releases). Create this now.
2. **Mac App Distribution** + **Mac Installer Distribution** — required for Mac App Store submission. Can defer to Phase 4.

**Steps for Developer ID Application:**
1. On your Mac, open Keychain Access → Certificate Assistant → Request a Certificate from a Certificate Authority. Save the CSR to disk.
2. In the Apple Developer portal → Certificates → create new → Developer ID Application. Upload the CSR.
3. Download the certificate, double-click to install in Keychain.
4. Export as `.p12` from Keychain Access (right-click the certificate → Export). Set a strong password.
5. Base64-encode the `.p12` for GitHub Secrets: `base64 -i certificate.p12 | pbcopy`

**Store securely:**
- The `.p12` file
- The `.p12` password
- The base64-encoded string (for GitHub Secrets)

**Timeline:** 15 minutes.

---

### GOO-XX: Audit and set bundle identifier in tauri.conf.json 🤖

**What:** Ensure the bundle identifier in `tauri.conf.json` is set to the final production value and is consistent everywhere.

**Implementation:**
1. Open `apps/desktop/src-tauri/tauri.conf.json`.
2. Verify `identifier` field matches the registered Bundle ID (e.g., `app.pikos.desktop`).
3. Check that `productName` is set to `Pikos`.
4. Verify `version` follows semver and is set to something reasonable for beta (e.g., `0.1.0`).
5. Check `bundle.macOS.signingIdentity` — should be set to `Developer ID Application: <Your Name> (<Team ID>)` or left empty if signing is handled entirely by the CI action (preferred — don't hardcode the identity, let the CI environment handle it).
6. Ensure `bundle.macOS.minimumSystemVersion` is set (recommend `10.15` for Catalina+ or `11.0` for Big Sur+ depending on your Tauri 2 minimum).

**Acceptance:** `pnpm tauri build` doesn't error on identifier-related config issues.

---

## Phase 2 (friends beta pipeline — private repo, direct distribution)

---

### GOO-52A: Set up GitHub Actions release workflow for macOS 🧑🤖

**What:** Create a GitHub Actions workflow that produces signed, notarized macOS builds on git tag push.

**Prerequisites:** Apple Developer enrollment complete, certificates generated, bundle ID registered.

**🧑 You do first:**
Add these GitHub repository secrets:
- `APPLE_CERTIFICATE` — base64-encoded `.p12`
- `APPLE_CERTIFICATE_PASSWORD` — the `.p12` export password
- `APPLE_API_KEY` — contents of the `.p8` file
- `APPLE_API_KEY_ID` — the Key ID from App Store Connect
- `APPLE_API_ISSUER_ID` — the Issuer ID from App Store Connect
- `APPLE_TEAM_ID` — your Team ID
- `TAURI_SIGNING_PRIVATE_KEY` — (created in auto-updater task, but add the secret here)
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` — password for the above

**🤖 Claude Code implements:**
Create `.github/workflows/release.yml`:

```
Trigger: push tags matching `v*`
Runner: macos-latest (Apple Silicon)

Steps:
1. Checkout code
2. Setup Node.js (match .nvmrc or package.json engines)
3. Setup Rust (stable)
4. Setup pnpm (match packageManager field in root package.json)
5. Install dependencies: `pnpm install`
6. Import signing certificate from APPLE_CERTIFICATE secret
7. Run `pnpm tauri build --target universal-apple-darwin` (universal binary)
8. Notarize the .dmg using `apple-api-key`, `apple-api-key-id`, `apple-api-issuer` via tauri's built-in notarization (Tauri 2 handles this via `tauri.conf.json` `bundle.macOS.notarization` or env vars — check Tauri 2 docs for the current mechanism)
9. Create GitHub Release from the tag
10. Upload artifacts: .dmg, updater .json manifest, .tar.gz (for updater)

Naming convention: `Pikos_<version>_universal.dmg`
```

**Important Tauri 2 specifics to check:**
- Tauri 2 may use `APPLE_SIGNING_IDENTITY`, `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD` env vars directly — read the Tauri 2 signing docs at https://tauri.app/distribute/sign/macos/
- Notarization in Tauri 2 might use `notarytool` under the hood — the API key approach (not app-specific password) is more reliable in CI
- The `tauri-apps/tauri-action` GitHub Action may handle all of this — check if it supports Tauri 2 or if manual `pnpm tauri build` + separate notarization step is needed

**Acceptance criteria:**
- Push a `v0.1.0-test` tag → workflow runs → GitHub Release appears with a signed, notarized `.dmg`
- Download the `.dmg` on a clean Mac (or different user account) → opens without Gatekeeper warning
- Delete the test release and tag after verification

---

### GOO-52B: Set up Tauri auto-updater 🤖

**What:** Configure the Tauri updater plugin so the app can self-update from GitHub Releases.

**Implementation:**

1. **Generate updater keypair:**
   Run `pnpm tauri signer generate -w ~/.tauri/pikos.key` (or wherever you keep keys). This produces a keypair. The private key goes to GitHub Secrets (`TAURI_SIGNING_PRIVATE_KEY`). The public key goes in the Tauri config.

2. **Configure `tauri.conf.json`:**
   Add/update the updater config:
   ```json
   {
     "plugins": {
       "updater": {
         "active": true,
         "dialog": true,
         "pubkey": "<PUBLIC_KEY_FROM_STEP_1>",
         "endpoints": [
           "https://github.com/YOUR_ORG/YOUR_REPO/releases/latest/download/latest.json"
         ]
       }
     }
   }
   ```
   Note: The endpoint URL structure depends on whether the repo is public or private. For a private repo, you'll need a different approach (e.g., a proxy endpoint or Tauri's GitHub provider). Decide based on your repo visibility at launch time.

3. **Update the CI workflow (from GOO-52A):**
   The build step needs to produce the update manifest. Tauri 2's build process generates a `latest.json` file alongside the build artifacts when the updater is configured. Ensure the CI workflow uploads this file to the GitHub Release.

4. **Add updater dependency:**
   - Add `@tauri-apps/plugin-updater` to the frontend: `pnpm add @tauri-apps/plugin-updater` (in `apps/desktop`)
   - Add the plugin to `src-tauri/Cargo.toml` and register it in the Tauri plugin builder in `src-tauri/src/lib.rs` (or `main.rs`)

5. **Implement update check in the app:**
   For now, use Tauri's built-in dialog (`"dialog": true` in config) which shows a native OS dialog when an update is available. This is good enough for friends beta. A custom UI component (in-app notification bar, settings panel check button) comes later.

   At minimum, add an update check on app launch:
   ```typescript
   import { check } from '@tauri-apps/plugin-updater';

   // Call on app startup (e.g., in your root App component's useEffect)
   async function checkForUpdates() {
     try {
       const update = await check();
       if (update?.available) {
         // Built-in dialog handles the rest if dialog: true
         await update.downloadAndInstall();
       }
     } catch (e) {
       console.error('Update check failed:', e);
       // Silently fail — don't block the user
     }
   }
   ```

**Acceptance criteria:**
- Build v0.1.0, install it
- Push v0.1.1 tag, CI builds and creates release with `latest.json`
- v0.1.0 app detects the update on next launch
- Update installs and app restarts at v0.1.1
- If update check fails (offline, GitHub down), app continues normally

---

### GOO-52C: Linux build target in CI ✅ (done)

macOS universal + Linux x86_64 are already in the release workflow matrix. No Windows binary — per GTM, unsigned `.msi` triggers SmartScreen warnings that look like malware. Technical Windows users can build from source. Revisit only if non-technical Windows demand materializes.

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

> Phase 3 is a single coordinated moment: repo goes public, `/download` page goes live, `/open` page goes live, blog posts publish. The repo must be public before `/download` works — GitHub Releases return 404 for unauthenticated requests on private repos.

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

### GOO-53-OPEN: Build /open page 🤖

**What:** Technical-audience landing page — architecture, local-first philosophy, SQLite data ownership, source-available repo.

**Content (from GTM):**
- Local-first philosophy: your data is a SQLite file on your disk, inspect it with any SQLite client
- Architecture: Tauri 2 + React + TypeScript, no Electron, no cloud dependency
- Privacy claim is auditable: link to public repo
- Speaks to the "Obsidian + TickTick" pain point with technical specifics
- Links: GitHub repo, Homebrew install (if ready), build-from-source instructions
- Does NOT lead with origin story or solo-dev angle

**Acceptance criteria:**
- Page exists at `/open`
- Links to public GitHub repo
- No broken links or placeholder content

---

### GOO-XX: Make repo public 🧑

**What:** Flip the private monorepo to public (or set up the public mirror repo per GTM).

**Decision needed:** Single repo flip vs. separate public mirror synced by CI. Mirror is more work but keeps mobile code private when it exists. If mobile doesn't exist yet, flipping the existing repo is simpler.

**Must happen before `/download` page goes live** — GitHub Releases are inaccessible on private repos.

---

### GOO-XX: Create RELEASING.md 🤖

**What:** Document the release process so it's repeatable and Claude Code can assist with future releases.

**Contents:**
```markdown
# Releasing Pikos

## Version bumping
1. Update version in `apps/desktop/src-tauri/tauri.conf.json`
2. Update version in `apps/desktop/package.json`
3. (If they exist) Update version in `apps/desktop/src-tauri/Cargo.toml`
4. Commit: `git commit -am "chore: bump version to vX.Y.Z"`

## Creating a release
1. Tag: `git tag vX.Y.Z`
2. Push: `git push origin vX.Y.Z`
3. CI builds, signs, notarizes, and creates GitHub Release automatically
4. Verify the release: download .dmg on a clean machine, check Gatekeeper, check auto-updater

## Hotfix process
1. Fix on main (or cherry-pick to a release branch if needed)
2. Bump patch version
3. Tag and push — auto-updater delivers it to existing users

## Troubleshooting
- Notarization failed: Check CI logs for Apple's rejection reason. Usually entitlements or hardened runtime issues.
- Updater not detecting new version: Verify `latest.json` is uploaded and the endpoint URL in tauri.conf.json matches.
- Gatekeeper still warns: Stapling may have failed. Re-run `xcrun stapler staple Pikos.dmg` locally.
```

**Acceptance:** File exists at repo root, accurately reflects the actual workflow after GOO-52A is done. Update this file whenever the process changes.

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