#!/usr/bin/env bash
# Prove the Linux credential backend round-trips against a real Secret Service.
#
#   scripts/linux-keyring-check.sh          # on Linux, or inside a container
#   scripts/linux-keyring-check.sh --docker # from a Mac, in a Debian container
#
# Every other test of the keychain injects an in-memory store, so a build with no backend named
# for the platform passes all of them and then forgets every password at runtime — which is
# exactly what shipped. This runs the one test that asks the OS.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

if [ "${1:-}" = "--docker" ]; then
  exec docker run --rm -v "$ROOT":/src -w /src \
    -e CARGO_TARGET_DIR=/tmp/target rust:1-bookworm \
    bash -c "apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq \
      gnome-keyring libdbus-1-dev dbus-x11 >/dev/null && scripts/linux-keyring-check.sh"
fi

# gnome-keyring asks a graphical prompter to create its first collection, and a headless session
# has none. Naming the default keyring up front is what keeps it from asking.
mkdir -p "$HOME/.local/share/keyrings"
printf 'login' > "$HOME/.local/share/keyrings/default"

dbus-run-session -- bash -c '
  set -euo pipefail
  eval "$(printf "\n" | gnome-keyring-daemon --unlock --components=secrets 2>/dev/null)"
  export GNOME_KEYRING_CONTROL
  cargo test -p pikos-calendar-sync --lib -- --ignored the_system_keychain_round_trips
'
