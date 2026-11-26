#!/usr/bin/env bash
# Install each Linux artifact on each distribution we claim to support, in containers.
#
#   scripts/linux-package-check.sh <dir-with-artifacts>
#
# Answers what a build log cannot: does the package install on a machine that did not build it,
# and does every library it needs resolve there. The worst failure to ship is an app that installs,
# then dies or paints nothing on launch with a linker error the user never sees.
#
# Needs Docker. On Apple Silicon the images run under emulation, which is slow but works.
set -euo pipefail

ART="$(cd "${1:?usage: linux-package-check.sh <dir-with-artifacts>}" && pwd)"
DEB_DISTROS=${PIKOS_DEB_DISTROS:-"ubuntu:22.04 ubuntu:24.04 debian:12"}
APPIMAGE_DISTROS=${PIKOS_APPIMAGE_DISTROS:-"debian:12 fedora:40"}

# What an AppImage may take from the host rather than bundle: the base X, GL and text stack every
# desktop has. A missing library outside this set (webkit, gtk) means the bundle lost something.
HOST_PROVIDED="libEGL.so.1 libGL.so.1 libX11-xcb.so.1 libX11.so.6 libdrm.so.2 libexpat.so.1
libfontconfig.so.1 libfreetype.so.6 libfribidi.so.0 libgbm.so.1 libharfbuzz.so.0 libxcb.so.1"

deb=$(find "$ART" -name "*.deb" | head -1)
appimage=$(find "$ART" -name "*.AppImage" | head -1)
cli=$(find "$ART" -name "pikos-cli-*linux*.tar.gz" | head -1)

# A `find` that matches nothing would skip its block and exit 0, so the two artifacts the desktop
# build always produces are required.
[ -n "$deb" ] || { echo "no .deb in $ART"; exit 1; }
[ -n "$appimage" ] || { echo "no AppImage in $ART"; exit 1; }

# $ART is mounted at /artifacts and Tauri nests its output under it, so the container needs each
# path relative to the mount. A `basename` points at a file that is not there, which apt reports
# as "Unsupported file", so it looks like a bad package.
deb_rel=${deb#"$ART"/}
appimage_rel=${appimage#"$ART"/}
cli_rel=${cli#"$ART"/}

fail=0
run() { docker run --rm --platform linux/amd64 -v "$ART":/artifacts:ro "$1" bash -c "$2"; }

if [ -n "$deb" ]; then
  for image in $DEB_DISTROS; do
    echo "── .deb on $image"
    run "$image" '
      set -eu
      export DEBIAN_FRONTEND=noninteractive
      apt-get update -qq
      apt-get install -y -qq /artifacts/'"$deb_rel"' >/dev/null
      # Asked of dpkg, since Tauri names the binary; `ldd` on a missing path fails in a way
      # `grep "not found" || true` swallows.
      package=$(dpkg-deb -f /artifacts/'"$deb_rel"' Package)
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
      cp /artifacts/'"$appimage_rel"' app.AppImage && chmod +x app.AppImage
      # --appimage-extract needs no FUSE, which a container lacks.
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

# Optional, and said out loud when absent: the CLI comes from a different job, so the desktop
# bundle directory has no tarball. A silent skip would read exactly like a pass.
if [ -z "$cli" ]; then
  echo "── CLI tarball: none in $ART, skipped"
else
  echo "── CLI tarball on debian:12"
  run debian:12 '
    set -eu
    cd /tmp && tar xzf /artifacts/'"$cli_rel"'
    bin=$(find . -type f -path "*/bin/pikos" | head -1)
    test -x "$bin" || { echo "   no pikos binary in the tarball"; exit 1; }
    "$bin" --version
    echo "   runs headless"
  ' || fail=1
fi

exit $fail
