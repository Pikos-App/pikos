#!/usr/bin/env bash
# Install the .deb in a container, start the app on a virtual display, and confirm it painted
# something.
#
#   scripts/linux-launch-check.sh <dir-with-artifacts> [screenshot-dir]
#
# "Painted something" is measured as the number of distinct colours in a screenshot of the root
# window. A working UI has thousands; a blank window has one. That is a crude line and a load-
# bearing one: a white window is what a failed bundle, a CSP that blocks the scripts, or a crash
# in the first render all look like, and none of them fail a build.
#
# **It cannot see the driver bug.** The container renders with llvmpipe, in software. Checked on
# 2026-09-15 with the DMABUF renderer forced back on, which is the path `PKOS-0045` blames: it
# still painted. A blank window on somebody's GPU needs that GPU (`C108`).
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
apt-get install -y -qq xvfb dbus-x11 imagemagick x11-apps libgl1-mesa-dri >/dev/null 2>&1
apt-get install -y -qq /artifacts/*.deb >/dev/null 2>&1

# No GPU in a container, and WebKit's bubblewrap sandbox needs privileges a container does not
# hand out. Both are about running here at all, not about what is being tested.
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
  # The only assertion the startup log line has. Without it the line can stop being written and
  # nothing anywhere notices, which matters because it is what a blank-window report is read from.
  grep -h "linux render environment" /tmp/app.log \
    || { echo "   the app did not log its render environment"; exit 1; }
  errors=$(grep -c "\[ERROR\]" /tmp/app.log || true)
  [ "$errors" = "0" ] || { echo "   $errors error line(s) in the log:"; grep "\[ERROR\]" /tmp/app.log | head -5; exit 1; }
  # One colour is a blank window. A painted UI runs to four figures; 50 is far below anything real
  # and far above anything blank.
  [ "$colours" -gt 50 ] || { echo "   the window is blank"; exit 1; }
  echo "   the app started and painted a window"
  cp /tmp/shot.png /shots/linux-launch.png 2>/dev/null || true
'
INNER

# Resolved once: two `$(mktemp -d)` expansions make two directories, and the screenshot then lands
# in the one that was not mounted.
SHOTS="${SHOTS:-$(mktemp -d)}"
mkdir -p "$SHOTS"
docker run --rm --platform linux/amd64 \
  -v "$ART":/artifacts:ro \
  -v "$probe":/probe.sh:ro \
  -v "$SHOTS":/shots \
  ubuntu:24.04 bash /probe.sh
echo "   screenshot: $SHOTS/linux-launch.png"
