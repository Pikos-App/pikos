#!/usr/bin/env bash
# Confirm a built macOS bundle is signed, notarized and stapled.
#
#   scripts/macos-signing-check.sh <dir-with-bundle> [--signature-only]
#
# `--signature-only` stops after the signature checks, for the local signed build
# (`pnpm qa:build`), which is deliberately not notarized — notarization needs the
# pipeline's credentials. The half it still answers is the one that bites locally:
# a build whose identity did not resolve is ad-hoc signed, and an ad-hoc build
# delivers no notifications at all, which reads as "notifications are broken".
#
# The build log cannot answer this. `tauri build` signs when it finds an identity
# and notarizes when it finds an API key, and with either one missing or expired
# it prints nothing unusual and exits 0. What reaches the user is "Pikos is
# damaged and can't be opened", for everyone, with no fix short of a new release.
#
# Three separate questions, in the order they fail:
#
#   codesign --verify   the signature exists and the bundle has not been altered
#   stapler validate    a notarization ticket is attached to the artifact itself,
#                       which is what makes first launch work offline
#   spctl --assess      Gatekeeper would actually let it run — the only one of the
#                       three that answers the user's question rather than ours
#
# A Developer ID build that is signed but not stapled passes the first check and
# fails the third on any machine that is offline or behind a captive portal, so
# the pass is not redundant with the QA rung that opens the DMG by hand.
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

# --deep walks the embedded frameworks and helpers, not just the outer bundle;
# an unsigned nested binary is enough for Gatekeeper to reject the whole thing.
# It logs a line per nested item, which is hundreds in a Tauri app — kept back
# unless it fails, where it is the only thing that names which one.
if ! out=$(codesign --verify --deep --strict --verbose=2 "$app" 2>&1); then
  printf '%s\n' "$out"
  fail "codesign could not verify $(basename "$app")"
fi
pass "codesign" "$(basename "$app")"

# `|| true` because an ad-hoc signature prints no Authority line at all, and under
# `pipefail` the empty grep would abort the script before the case below could say
# why — a check that exits non-zero without naming its reason is its own bug.
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

# `-t exec` is not `-t install`: this asks whether the app may *run*, which is
# the check first launch performs.
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
