#!/usr/bin/env bash
# Confirm a built macOS bundle is signed, notarized and stapled.
#
#   scripts/macos-signing-check.sh <dir-with-bundle> [--signature-only]
#
# `--signature-only` stops after the signature checks, for the local signed build (`pnpm
# qa:build), which is not notarized because that needs the pipeline's credentials. It still
# catches the local failure: a build whose identity did not resolve is ad-hoc signed and delivers
# no notifications at all.
#
# The build log cannot answer this. `tauri build` signs when it finds an identity and notarizes
# when it finds an API key, and with either missing or expired it prints nothing unusual and
# exits 0. Users then get "Pikos is damaged and can't be opened", with no fix short of a new
# release.
#
# Three questions, in the order they fail:
#
#   codesign --verify   the signature exists and the bundle has not been altered
#   stapler validate    a notarization ticket is attached, so first launch works offline
#   spctl --assess      Gatekeeper would actually let it run
#
# A signed but unstapled Developer ID build passes the first check and fails the third on an
# offline machine, so this pass is not redundant with the QA rung that opens the DMG by hand.
set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
DIM='\033[2m'
RESET='\033[0m'

BUNDLE="$(cd "${1:?usage: macos-signing-check.sh <dir-with-bundle> [--signature-only]}" && pwd)"
SIGNATURE_ONLY="${2:-}"

fail() { printf "${RED}✗${RESET} %s\n" "$1"; exit 1; }
pass() { printf "${GREEN}✓${RESET} %s${DIM} %s${RESET}\n" "$1" "${2:-}"; }

app=$(find "$BUNDLE/macos" -maxdepth 1 -name "*.app" | head -1)
[ -n "$app" ] || fail "no .app under $BUNDLE/macos"

# --deep walks embedded frameworks and helpers: one unsigned nested binary makes Gatekeeper reject
# the whole bundle. Its per-item log runs to hundreds of lines in a Tauri app, so it is shown only
# on failure, where it names the culprit.
if ! out=$(codesign --verify --deep --strict --verbose=2 "$app" 2>&1); then
  printf '%s\n' "$out"
  fail "codesign could not verify $(basename "$app")"
fi
pass "codesign" "$(basename "$app")"

# `|| true` because an ad-hoc signature prints no Authority line, and under `pipefail` the empty
# grep would abort before the case below could say why.
authority=$(codesign -dvv "$app" 2>&1 | grep '^Authority=' | head -1 | cut -d= -f2- || true)
case "$authority" in
  "Developer ID Application:"*) pass "signed by" "$authority" ;;
  # A build with no identity is ad-hoc signed: it verifies cleanly above, and
  # delivers neither notifications nor Gatekeeper acceptance.
  *) fail "not a Developer ID signature: ${authority:-<none>}" ;;
esac

if [ "$SIGNATURE_ONLY" = "--signature-only" ]; then
  printf "\n${GREEN}Signed with a Developer ID.${RESET}${DIM} Notarization is the pipeline's half.${RESET}\n"
  exit 0
fi

xcrun stapler validate "$app" \
  || fail "no notarization ticket stapled to $(basename "$app") — it will be refused on a machine that cannot reach Apple"
pass "stapled" "$(basename "$app")"

if ! out=$(spctl --assess --type exec --verbose=4 "$app" 2>&1); then
  printf '%s\n' "$out"
  fail "Gatekeeper would refuse $(basename "$app")"
fi
pass "Gatekeeper accepts" "$(basename "$app")"

# The DMG is what people download, and it is notarized separately from the app
# inside it. A stapled app in an unstapled DMG still warns on first open.
dmg=$(find "$BUNDLE/dmg" -maxdepth 1 -name "*.dmg" 2>/dev/null | head -1)
if [ -n "$dmg" ]; then
  xcrun stapler validate "$dmg" \
    || fail "no notarization ticket stapled to $(basename "$dmg")"
  pass "stapled" "$(basename "$dmg")"
else
  printf "${DIM}  no .dmg in this bundle — skipped${RESET}\n"
fi

# The updater downloads this, not the DMG, and verifies it against the pubkey
# compiled into the running app. No .sig means every install stays where it is.
missing_sig=""
for archive in "$BUNDLE"/macos/*.tar.gz; do
  [ -e "$archive" ] || continue
  [ -f "$archive.sig" ] || missing_sig="$missing_sig $(basename "$archive")"
done
[ -z "$missing_sig" ] || fail "updater archive(s) with no .sig:$missing_sig"
pass "updater signatures"

printf "\n${GREEN}macOS bundle is signed, notarized and stapled.${RESET}\n"
