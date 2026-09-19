#!/usr/bin/env bash
# Connect a CalDAV account for real, on Linux, and prove the credential survives
# into another process.
#
#   scripts/linux-sync-check.sh          # on Linux, or inside a container
#   scripts/linux-sync-check.sh --docker # from a Mac, in a Debian container
#
# Radicale supplies the server and gnome-keyring the Secret Service, so the connect
# runs end to end: discovery over HTTP, the password into the OS store, then a poll
# that reads it back through a handle the connect never touched. Every other test of
# this path scripts the provider and injects a `HashMap` for the keychain, which is
# the combination that passed while the Linux build shipped with no keychain backend
# at all.
#
# **This is not §18.5.** It has no desktop session, so it cannot answer GNOME versus
# KDE, KWallet's Secret Service bridge, or Google's loopback opening a browser. It
# answers the row underneath all of them: does connecting work on Linux and does the
# password still be there afterwards.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CRATE=pikos-calendar-sync
PREFIX=commands::live_caldav_tests

if [ "${1:-}" = "--docker" ]; then
  exec docker run --rm -v "$ROOT":/src -w /src \
    -e CARGO_TARGET_DIR=/tmp/target rust:1-bookworm \
    bash -c "apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq \
      gnome-keyring libdbus-1-dev dbus-x11 libsecret-tools radicale curl >/dev/null && \
      scripts/linux-sync-check.sh"
fi

USER_NAME=pikos
PASSWORD=hunter2
PORT=5232
export PIKOS_CALDAV_URL="http://127.0.0.1:$PORT"
export PIKOS_CALDAV_USER="$USER_NAME"
export PIKOS_CALDAV_PASS="$PASSWORD"

step() { printf '\n── %s\n' "$1"; }

step "starting Radicale on $PORT"
conf=$(mktemp -d)
# No auth backend at all would let the wrong-password test connect happily, which
# would turn the rollback assertion green without the rollback ever running.
printf '%s:%s\n' "$USER_NAME" "$(printf '%s' "$PASSWORD")" > "$conf/users"
cat > "$conf/config" <<CONF
[server]
hosts = 127.0.0.1:$PORT
[auth]
type = htpasswd
htpasswd_filename = $conf/users
htpasswd_encryption = plain
[storage]
filesystem_folder = $conf/collections
CONF

python3 -m radicale --config "$conf/config" >"$conf/radicale.log" 2>&1 &
radicale_pid=$!
trap 'kill "$radicale_pid" 2>/dev/null || true' EXIT

for _ in $(seq 1 40); do
  if curl -fsS -u "$USER_NAME:$PASSWORD" "$PIKOS_CALDAV_URL/" >/dev/null 2>&1; then
    break
  fi
  sleep 0.25
done
curl -fsS -u "$USER_NAME:$PASSWORD" "$PIKOS_CALDAV_URL/" >/dev/null || {
  echo "Radicale never answered:"; cat "$conf/radicale.log"; exit 1; }

# An account with no collection discovers nothing, and the connect assertion would
# then fail for the wrong reason.
step "creating a calendar to discover"
curl -fsS -u "$USER_NAME:$PASSWORD" -X MKCALENDAR \
  "$PIKOS_CALDAV_URL/$USER_NAME/work/" >/dev/null || {
  echo "could not create a calendar:"; cat "$conf/radicale.log"; exit 1; }

# Naming the default keyring up front stops gnome-keyring asking a graphical
# prompter a headless session hasn't got. Same reason as linux-keyring-check.sh.
mkdir -p "$HOME/.local/share/keyrings"
printf 'login' > "$HOME/.local/share/keyrings/default"

step "connecting, then polling from a fresh keychain handle"
export CRATE PREFIX
dbus-run-session -- bash -c '
  set -euo pipefail
  # --replace for the reason linux-keyring-check.sh gives: a daemon already on the
  # control socket leaves this printing nothing.
  err=$(mktemp)
  address=$(printf "\n" | gnome-keyring-daemon --replace --unlock --components=secrets 2>"$err")
  [ -n "$address" ] || {
    echo "gnome-keyring-daemon printed no control address. It said:"
    cat "$err"
    exit 1
  }
  eval "$address"
  export SSH_AUTH_SOCK GNOME_KEYRING_CONTROL

  log=$(mktemp)
  # `cargo test` exits 0 when its filter matches nothing, so a renamed test would
  # leave this green having run none of it. The count is the assertion.
  cargo test -p "$CRATE" --lib -- --ignored --test-threads=1 "$PREFIX" 2>&1 | tee "$log"
  grep -q "test result: ok\. 2 passed" "$log" || {
    echo "   expected 2 tests to run; the filter matched something else"
    exit 1
  }
'

printf '\n✓ A CalDAV connect on Linux stores its password where a relaunch can find it.\n'
