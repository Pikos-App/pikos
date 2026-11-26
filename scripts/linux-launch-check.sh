#!/usr/bin/env bash
# Install the .deb in a container, start the app on a virtual display, and confirm it painted
# something.
#
#   scripts/linux-launch-check.sh <dir-with-artifacts> [screenshot-dir]
#
# "Painted something" is the number of distinct colours in a screenshot of the root window. A
# working UI has thousands; a blank window has one. A failed bundle, a CSP that blocks the scripts
# and a crash in the first render all look blank, and none of them fail a build.
#
# It cannot see a GPU driver bug: the container renders with llvmpipe in software, and a run with
# the DMABUF renderer forced on still painted.
set -euo pipefail

ART="$(cd "${1:?usage: linux-launch-check.sh <dir-with-artifacts> [screenshot-dir]}" && pwd)"
SHOTS="${2:-}"
deb=$(find "$ART" -name "*.deb" | head -1)
[ -n "$deb" ] || { echo "no .deb in $ART"; exit 1; }

probe=$(mktemp)
cat > "$probe" <<'INNER'
set -eu
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
# desktop-file-utils and xdg-utils: tauri-plugin-deep-link shells out to `update-desktop-database`
# and `xdg-mime` to register the URL scheme. A bare container has neither, so the app would log
# errors a real desktop never sees and the zero-errors check below would fail on the rig.
apt-get install -y -qq xvfb dbus-x11 imagemagick x11-apps libgl1-mesa-dri desktop-file-utils \
  xdg-utils >/dev/null 2>&1

# The bundle directory is mounted at /artifacts with the package nested under it, so a glob at the
# mount root matches nothing. apt then exits 100 with no output, which reads like a failed paint.
deb=$(find /artifacts -name '*.deb' | head -1)
[ -n "$deb" ] || { echo "no .deb under /artifacts"; exit 1; }
apt-get install -y -qq "$deb" >/dev/null

# A container has no GPU and denies WebKit's bubblewrap sandbox the privileges it needs.
export LIBGL_ALWAYS_SOFTWARE=1
export WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS=1

xvfb-run -a --server-args="-screen 0 1280x800x24" dbus-run-session -- bash -c '
  pikos >/tmp/app.log 2>&1 &
  pid=$!
  sleep 25
  kill -0 $pid 2>/dev/null || { echo "the app exited before it could be looked at"; tail -30 /tmp/app.log; exit 1; }
  import -window root /tmp/shot.png
  colours=$(convert /tmp/shot.png -format %k info:)
  echo "   distinct colours: $colours"
  # Without this assertion the startup line can stop being written unnoticed, and a blank-window
  # report is read from it.
  grep -h "linux render environment" /tmp/app.log \
    || { echo "   the app did not log its render environment"; exit 1; }
  errors=$(grep -c "\[ERROR\]" /tmp/app.log || true)
  [ "$errors" = "0" ] || { echo "   $errors error line(s) in the log:"; grep "\[ERROR\]" /tmp/app.log | head -5; exit 1; }
  # A painted UI runs to four figures and a blank window has one; 50 sits well between.
  [ "$colours" -gt 50 ] || { echo "   the window is blank"; exit 1; }
  echo "   the app started and painted a window"
  cp /tmp/shot.png /shots/linux-launch.png 2>/dev/null || true
'
INNER

# Resolved once: two `$(mktemp -d)` expansions would make two directories.
SHOTS="${SHOTS:-$(mktemp -d)}"
mkdir -p "$SHOTS"
docker run --rm --platform linux/amd64 \
  -v "$ART":/artifacts:ro \
  -v "$probe":/probe.sh:ro \
  -v "$SHOTS":/shots \
  ubuntu:24.04 bash /probe.sh
echo "   screenshot: $SHOTS/linux-launch.png"
