#!/usr/bin/env bash
# Fail if a release binary carries the build machine's home folder. Panic messages carry source
# paths, and every dependency's path starts with it, so an unremapped binary names the account it
# was built on. `release.yml` remaps it with `--remap-path-prefix`; this proves the remap reached
# the binary.
#
#   scripts/no-build-paths-check.sh <binary>...
set -euo pipefail

[ "$#" -gt 0 ] || { echo "usage: no-build-paths-check.sh <binary>..."; exit 2; }
status=0
for binary in "$@"; do
  [ -f "$binary" ] || { echo "::error::no binary at $binary"; status=1; continue; }
  hits=$(strings "$binary" | grep -c -F "$HOME/" || true)
  if [ "$hits" -gt 0 ]; then
    echo "::error::$binary names the build machine's home folder $hits times"
    status=1
  else
    echo "$binary: no build-machine paths"
  fi
done
exit "$status"
