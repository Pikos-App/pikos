#!/usr/bin/env bash
# Can somebody actually install Pikos with Homebrew, and is the tap pointing at this release?
#
#   scripts/brew-check.sh
#
# The tap is a second repository with no CI of its own, so nothing notices when a release ships
# and the cask keeps naming the version before it, or when Homebrew deprecates a stanza the tap
# still uses. Both are invisible until somebody tries to install.
#
# Audits, and fetches to prove each URL and checksum resolve. It installs nothing.
set -uo pipefail

TAP=${PIKOS_TAP:-pikos-app/tap}
REPO=${PIKOS_REPO:-Pikos-App/pikos}
CASK="$TAP/pikos"
BETA="$TAP/pikos@beta"
FORMULA="$TAP/pikos-cli"

fail=0
step() { printf '── %s\n' "$1"; }
check() { if "$@"; then return 0; else fail=1; return 1; fi; }

brew tap "$TAP" >/dev/null 2>&1 || true

step "audit"
check brew audit --strict --cask "$CASK" || echo "   the cask has problems"
check brew audit --strict --cask "$BETA" || echo "   the beta cask has problems"
check brew audit --strict "$FORMULA" || echo "   the cli formula has problems"

step "fetch, which verifies each url and checksum"
check brew fetch --cask "$CASK" >/dev/null || echo "   the cask's download or checksum is wrong"
check brew fetch "$FORMULA" >/dev/null || echo "   the formula's download or checksum is wrong"

# A deprecation warning is not an audit failure, and it is how a tap stops working a release later.
step "deprecations"
warnings=$(brew fetch --cask --force "$CASK" 2>&1 | grep -c "deprecated" || true)
if [ "$warnings" -gt 0 ]; then
  echo "   the cask uses $warnings deprecated stanza(s); brew fetch --cask --force names them"
  fail=1
fi

step "versions against what is published"
cask_version_of() {
  brew info --cask --json=v2 "$1" 2>/dev/null \
    | python3 -c 'import json,sys; print(json.load(sys.stdin)["casks"][0]["version"])' 2>/dev/null
}
# Every input below is read through `2>/dev/null`, so an unauthenticated or rate-limited `gh`
# yields empty strings on both sides and an equality test that passes having compared nothing.
# Unreadable is a failure here, not a skip.
compare() { # name, tap version, published version
  if [ -z "$2" ] || [ -z "$3" ]; then
    echo "   $1: could not read a version to compare (tap '$2', published '$3')"
    fail=1
  elif [ "$2" != "$3" ]; then
    echo "   $1: the tap says $2 and $3 is published"
    fail=1
  else
    echo "   $1 matches at $2"
  fi
}
stable=$(gh release view --repo "$REPO" --json tagName --jq '.tagName' 2>/dev/null | sed 's/^v//')
prerelease=$(gh release list --repo "$REPO" --limit 20 --json tagName,isPrerelease \
  --jq 'map(select(.isPrerelease))[0].tagName' 2>/dev/null | sed 's/^v//')
formula_version=$(brew info --json=v2 "$FORMULA" 2>/dev/null \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["formulae"][0]["versions"]["stable"])' 2>/dev/null)
compare "the cask" "$(cask_version_of "$CASK")" "$stable"
compare "the beta cask" "$(cask_version_of "$BETA")" "$prerelease"
# The CLI ships with the betas too, so it tracks whichever of the two is newer.
if [ -z "$formula_version" ] || { [ -z "$stable" ] && [ -z "$prerelease" ]; }; then
  echo "   the cli formula: could not read a version to compare"
  fail=1
elif [ "$formula_version" = "$stable" ] || [ "$formula_version" = "$prerelease" ]; then
  echo "   the cli formula matches at $formula_version"
else
  echo "   the cli formula: the tap says $formula_version, and $stable / $prerelease are published"
  fail=1
fi

exit $fail
