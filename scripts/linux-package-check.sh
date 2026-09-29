#!/usr/bin/env bash
# Install each Linux artifact on each distribution we claim to support, in containers.
#
#   scripts/linux-package-check.sh <dir-with-artifacts>
#
# Answers the question a build log cannot: does the package install on a machine that is not the
# one that built it, and does every library it needs actually resolve there. The failure this
# catches is the worst kind to ship — the app installs, then dies or paints nothing on launch,
# with a dynamic-linker error the user never sees.
#
# Needs Docker. On Apple Silicon the images run under emulation, which is slow but works.
set -euo pipefail

ART="$(cd "${1:?usage: linux-package-check.sh <dir-with-artifacts>}" && pwd)"
DEB_DISTROS=${PIKOS_DEB_DISTROS:-"ubuntu:22.04 ubuntu:24.04 debian:12"}
APPIMAGE_DISTROS=${PIKOS_APPIMAGE_DISTROS:-"debian:12 fedora:40"}

# What an AppImage may take from the host rather than bundle: the base X, GL and text stack every
# desktop has and no AppImage ships. Anything missing *outside* this set means the bundle itself
# lost something — webkit, gtk — which is the regression worth failing on.
HOST_PROVIDED="libEGL.so.1 libGL.so.1 libX11-xcb.so.1 libX11.so.6 libdrm.so.2 libexpat.so.1
libfontconfig.so.1 libfreetype.so.6 libfribidi.so.0 libgbm.so.1 libharfbuzz.so.0 libxcb.so.1"

deb=$(find "$ART" -name "*.deb" | head -1)
appimage=$(find "$ART" -name "*.AppImage" | head -1)
cli=$(find "$ART" -name "pikos-cli-*linux*.tar.gz" | head -1)

# A `find` that matches nothing used to skip its whole block and still exit 0, so a renamed or
# missing artifact read as a pass. The two the desktop build always produces are required.
[ -n "$deb" ] || { echo "no .deb in $ART"; exit 1; }
[ -n "$appimage" ] || { echo "no AppImage in $ART"; exit 1; }

fail=0
run() { docker run --rm --platform linux/amd64 -v "$ART":/artifacts:ro "$1" bash -c "$2"; }

if [ -n "$deb" ]; then
  for image in $DEB_DISTROS; do
    echo "── .deb on $image"
    run "$image" '
      set -eu
      export DEBIAN_FRONTEND=noninteractive
      apt-get update -qq
      # `apt-get install ./x.deb` resolves the package own Depends; `dpkg -i` would not.
      apt-get install -y -qq /artifacts/'"$(basename "$deb")"' >/dev/null
      # Asked of dpkg rather than assumed to be /usr/bin/pikos: Tauri names the binary, and an
      # `ldd` on a path that does not exist fails in a way `grep "not found" || true` swallows.
      package=$(dpkg-deb -f /artifacts/'"$(basename "$deb")"' Package)
      bin=$(dpkg -L "$package" | grep -E "^/usr/bin/" | head -1)
      [ -n "$bin" ] && [ -x "$bin" ] || { echo "   the .deb installed no executable in /usr/bin"; exit 1; }
      missing=$(ldd "$bin" | grep "not found" || true)
      [ -z "$missing" ] || { echo "$missing"; exit 1; }
      echo "   installs $bin, and every library resolves"
    ' || fail=1
  done
fi

if [ -n "$appimage" ]; then
  for image in $APPIMAGE_DISTROS; do
    echo "── AppImage on $image"
    run "$image" '
      set -eu
      cd /tmp
      cp /artifacts/'"$(basename "$appimage")"' app.AppImage && chmod +x app.AppImage
      # --appimage-extract needs no FUSE, which a container has not got, and this is about the
      # bundle contents rather than about FUSE.
      ./app.AppImage --appimage-extract >/dev/null
      test -x squashfs-root/usr/bin/pikos
      allowed="'"$HOST_PROVIDED"'"
      unexpected=""
      for lib in $(LD_LIBRARY_PATH=squashfs-root/usr/lib ldd squashfs-root/usr/bin/pikos \
                   | grep "not found" | awk "{print \$1}" | sort -u); do
        echo "$allowed" | tr " " "\n" | grep -qx "$lib" || unexpected="$unexpected $lib"
      done
      [ -z "$unexpected" ] || { echo "   not bundled and not a host library:$unexpected"; exit 1; }
      echo "   extracts, and bundles everything it should"
    ' || fail=1
  done
fi

# Optional, and said out loud when it is absent: the CLI is built by a different job, so pointing
# this script at the desktop bundle directory finds no tarball and that is not a failure. A silent
# skip is, because it reads exactly like a pass.
if [ -z "$cli" ]; then
  echo "── CLI tarball: none in $ART, skipped"
else
  echo "── CLI tarball on debian:12"
  run debian:12 '
    set -eu
    cd /tmp && tar xzf /artifacts/'"$(basename "$cli")"'
    bin=$(find . -type f -path "*/bin/pikos" | head -1)
    test -x "$bin" || { echo "   no pikos binary in the tarball"; exit 1; }
    "$bin" --version
    echo "   runs headless"
  ' || fail=1
fi

exit $fail
