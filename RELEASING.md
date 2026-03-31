# Releasing Pikos

## Version bumping

1. Update `version` in `apps/desktop/src-tauri/tauri.conf.json`
2. Update `version` in `apps/desktop/package.json`
3. Update `version` in `apps/desktop/src-tauri/Cargo.toml`
4. Commit: `git commit -am "chore: bump version to vX.Y.Z"`

## Creating a release

1. Tag: `git tag vX.Y.Z`
2. Push tag: `git push origin vX.Y.Z`
3. CI builds all three platforms (macOS universal, Linux x64, Windows x64) and creates a **draft** GitHub Release
4. Review the draft release, verify artifacts, then publish

## What CI produces

| Platform | Artifacts |
|----------|-----------|
| macOS | `.dmg` (universal binary — Apple Silicon + Intel) |
| Linux | `.deb`, `.AppImage` |
| Windows | `.exe` (NSIS), `.msi` |

The workflow lives at `.github/workflows/release.yml`. It triggers on `v*` tags and `workflow_dispatch`.

## Verification checklist

- [ ] Download `.dmg` from the GitHub Release (not local build output)
- [ ] Open on a Mac — check Gatekeeper behavior (will warn until signing/notarization is set up)
- [ ] App icon renders correctly in dock and Finder
- [ ] Auto-updater detects the new version (once updater is configured)
- [ ] Linux: `.AppImage` runs on a clean Ubuntu install
- [ ] Windows: `.exe` installs and launches (SmartScreen warning expected until code signing cert is purchased)

## Hotfix process

1. Fix on main (or cherry-pick to a release branch if needed)
2. Bump patch version
3. Tag and push — auto-updater delivers it to existing users

## Signing status

- **macOS**: Not yet signed/notarized. Requires Apple Developer enrollment + certificates. Gatekeeper will warn on download.
- **Windows**: No code signing cert. SmartScreen will warn. Acceptable for beta.
- **Linux**: No signing needed.

Once macOS signing is configured, the CI workflow needs these GitHub Secrets:
- `APPLE_CERTIFICATE` — base64-encoded `.p12`
- `APPLE_CERTIFICATE_PASSWORD`
- `APPLE_API_KEY` — `.p8` file contents
- `APPLE_API_KEY_ID`
- `APPLE_API_ISSUER_ID`
- `APPLE_TEAM_ID`

## Troubleshooting

- **Notarization failed**: Check CI logs for Apple's rejection reason. Usually entitlements or hardened runtime issues.
- **Updater not detecting new version**: Verify `latest.json` is uploaded to the release and the endpoint URL in `tauri.conf.json` matches.
- **Gatekeeper still warns after signing**: Stapling may have failed. Re-run `xcrun stapler staple Pikos.dmg` locally.
- **CI build fails on Linux**: Missing system deps — check the `apt-get install` step in the workflow.
