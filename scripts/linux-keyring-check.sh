#!/usr/bin/env bash
# Prove the Linux credential backend works against a real Secret Service, and says something
# useful when there isn't one.
#
#   scripts/linux-keyring-check.sh          # on Linux, or inside a container
#   scripts/linux-keyring-check.sh --docker # from a Mac, in a Debian container
#
# Every other test of the keychain injects an in-memory store, so a build with no backend named
# for the platform passes all of them and then forgets every password at runtime — which is
# exactly what shipped. These are the tests that ask the OS.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CRATE=pikos-calendar-sync
PREFIX=keychain::keychain_tests

if [ "${1:-}" = "--docker" ]; then
  exec docker run --rm -v "$ROOT":/src -w /src \
    -e CARGO_TARGET_DIR=/tmp/target rust:1-bookworm \
    bash -c "apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq \
      gnome-keyring libdbus-1-dev dbus-x11 libsecret-tools >/dev/null && scripts/linux-keyring-check.sh"
fi

step() { printf '\n── %s\n' "$1"; }

# `cargo test` exits 0 when its filter matches nothing, so a renamed test would leave this whole
# script green having run none of it. The expected count is the assertion.
run_tests() {
  local expected=$1 log
  shift
  log=$(mktemp)
  if ! cargo test -p "$CRATE" --lib -- --ignored --exact --test-threads=1 "$@" 2>&1 | tee "$log"; then
    return 1
  fi
  grep -q "test result: ok\. $expected passed" "$log" || {
    echo "   expected $expected tests to run; the filter matched something else"
    return 1
  }
}

# gnome-keyring asks a graphical prompter to create its first collection, and a headless session
# has none. Naming the default keyring up front is what keeps it from asking.
mkdir -p "$HOME/.local/share/keyrings"
printf 'login' > "$HOME/.local/share/keyrings/default"

step "with a Secret Service running"
export CRATE PREFIX
export -f run_tests
dbus-run-session -- bash -c '
  set -euo pipefail
  # Not `eval "$(…)"` on its own line: a command substitution consumed as an argument hides its
  # own failure from set -e, so a daemon that never started would read as an empty address.
  address=$(printf "\n" | gnome-keyring-daemon --unlock --components=secrets)
  [ -n "$address" ] || { echo "gnome-keyring-daemon printed no control address"; exit 1; }
  eval "$address"
  export GNOME_KEYRING_CONTROL
  run_tests 2 "$PREFIX::the_system_keychain_round_trips" \
              "$PREFIX::a_deleted_credential_is_gone_from_the_session_keyring"
'

# Outside dbus-run-session and with any inherited address cleared, so nothing is listening —
# which is what a minimal window manager or a headless login gives you.
step "with no Secret Service at all"
env -u DBUS_SESSION_BUS_ADDRESS -u GNOME_KEYRING_CONTROL \
  bash -c 'run_tests 1 "$PREFIX::a_session_with_no_keyring_says_which_one_to_start"'
