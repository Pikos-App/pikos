#!/usr/bin/env bash
# Point the Homebrew tap at a published release.
#
#   scripts/brew-bump.sh <tag> [--push]
#
# Without --push it prints the change and leaves the tap alone. A stable tag moves the
# cask and the CLI formula, and the beta cask when no newer beta is published; a prerelease
# moves the beta cask only. Checksums come from
# the digests GitHub publishes with each asset, so nothing is downloaded.
#
# Pushing needs write access to the tap: TAP_TOKEN in CI, or `gh` auth locally.

set -euo pipefail

TAG="${1:-}"
PUSH="${2:-}"
if [[ ! "$TAG" =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-.+)?$ ]] || [[ -n "$PUSH" && "$PUSH" != "--push" ]]; then
  echo "Usage: scripts/brew-bump.sh <vX.Y.Z[-pre]> [--push]" >&2
  exit 1
fi
VERSION="${TAG#v}"
REPO="Pikos-App/pikos"
TAP_REPO="Pikos-App/homebrew-tap"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

if [ -n "${TAP_TOKEN:-}" ]; then
  git clone --quiet --depth 1 "https://x-access-token:${TAP_TOKEN}@github.com/${TAP_REPO}.git" "$WORK/tap"
else
  gh repo clone "$TAP_REPO" "$WORK/tap" -- --quiet --depth 1
fi

digests="$WORK/digests"
gh release view "$TAG" --repo "$REPO" --json assets \
  --jq '.assets[] | "\(.name) \(.digest)"' > "$digests"

python3 - "$WORK/tap" "$VERSION" "$digests" "$(cd "$(dirname "$0")" && pwd)/lib/newest-version.py" <<'PY'
import pathlib, re, subprocess, sys

tap, version, digests, newest_version = pathlib.Path(sys.argv[1]), sys.argv[2], sys.argv[3], sys.argv[4]
sha = {}
for line in open(digests):
    name, digest = line.split()
    sha[name] = digest.removeprefix("sha256:")

def need(name):
    if name not in sha or not re.fullmatch(r"[0-9a-f]{64}", sha[name]):
        sys.exit(f"the release has no published digest for {name}")
    return sha[name]

def cask(path):
    text = path.read_text()
    text = re.sub(r'version "[^"]+"', f'version "{version}"', text, count=1)
    text = re.sub(r'sha256 "[0-9a-f]{64}"', f'sha256 "{need("Pikos-macos-universal.dmg")}"', text, count=1)
    path.write_text(text)

beta = tap / "Casks/pikos@beta.rb"
if "-" in version:
    cask(beta)
else:
    cask(tap / "Casks/pikos.rb")
    # The beta cask follows a stable release that overtakes it, since the beta it named is deleted
    # once its release ships. A beta still ahead, like 1.0.0-beta.1 over 0.5.1, is left alone.
    beta_version = re.search(r'version "([^"]+)"', beta.read_text()).group(1)
    newest = subprocess.run(
        [sys.executable, newest_version, beta_version, version],
        check=True, capture_output=True, text=True,
    ).stdout.strip()
    if newest == version:
        cask(beta)
    formula = tap / "Formula/pikos-cli.rb"
    lines = formula.read_text().split("\n")
    for i, line in enumerate(lines):
        url = re.search(r'pikos-cli-[^/"]+?-((?:aarch64|x86_64)-[a-z0-9_-]+)\.tar\.gz', line)
        if not url:
            continue
        target = url.group(1)
        lines[i] = re.sub(r"/v[^/]+/pikos-cli-[^/\"]+\.tar\.gz",
                          f"/v{version}/pikos-cli-{version}-{target}.tar.gz", line)
        lines[i + 1] = re.sub(r'sha256 "[0-9a-f]{64}"',
                              f'sha256 "{need(f"pikos-cli-{version}-{target}.tar.gz")}"', lines[i + 1])
    formula.write_text("\n".join(lines))
PY

cd "$WORK/tap"
if git diff --quiet; then
  echo "[brew] the tap already names $TAG"
  exit 0
fi
git --no-pager diff --stat
if [ "$PUSH" != "--push" ]; then
  git --no-pager diff
  echo "[brew] dry run; pass --push to publish this to the tap"
  exit 0
fi
git -c user.name="pikos-release" -c user.email="hello@pikos.app" commit --quiet -am "pikos ${VERSION}"
git push --quiet origin HEAD
echo "[brew] the tap names $TAG"
