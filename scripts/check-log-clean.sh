#!/usr/bin/env bash
# Fail when the app's own log carries warnings or errors nobody has accounted for.
#
#   scripts/check-log-clean.sh [--since YYYY-MM-DD] [path-to-log]
#
# Not part of `pnpm verify`: the log only exists where the app has actually run,
# and CI never runs it. This is a release-time gate, run against a machine that
# has been using the build.
#
# The premise is that a WARN the app emits about itself is either a defect or a
# line that should not be there. Both are worth a decision. Left ungated, a log
# fills with warnings nobody acts on, which trains everyone to scroll past the
# next one — and the next one is the render loop.
#
# EXPECTED below holds patterns that are known and accounted for. An entry is a
# claim that the line is understood, not that it is harmless.

set -uo pipefail

LOG="${HOME}/Library/Logs/app.pikos.desktop/pikos.log"
SINCE=""

while [ $# -gt 0 ]; do
  case "$1" in
    --since) SINCE="$2"; shift 2 ;;
    *) LOG="$1"; shift ;;
  esac
done

if [ ! -f "$LOG" ]; then
  echo "[log-check] no log at $LOG — run the app first" >&2
  exit 1
fi

# Each pattern is an extended regex matched against the whole line.
EXPECTED=(
  # Only ever emitted by an unbundled dev build; the packaged app takes the
  # real UNUserNotificationCenter path and never logs this.
  'un_setup_unavailable \(unbundled build\)'
)

filtered=$(mktemp)
trap 'rm -f "$filtered"' EXIT

if [ -n "$SINCE" ]; then
  awk -v since="[$SINCE]" '$0 >= since' "$LOG" > "$filtered"
else
  cp "$LOG" "$filtered"
fi

hits=$(grep -E '\[(WARN|ERROR)\]' "$filtered" || true)

for pattern in "${EXPECTED[@]}"; do
  hits=$(printf '%s\n' "$hits" | grep -vE "$pattern" || true)
done

hits=$(printf '%s\n' "$hits" | sed '/^$/d')

# A second Pikos against one profile is two notification schedulers and two sync
# loops over one SQLite file, and it announces itself here rather than on screen:
# the reminder arrives twice and nothing says why. The single-instance guard makes
# this unreachable, so a mismatch means the guard did not hold — which is worth a
# release gate, because the symptom is otherwise indistinguishable from a bug in
# the scheduler.
starts=$(grep -cE 'Pikos .* starting on' "$filtered" || true)
schedulers=$(grep -cF 'Notification scheduler started' "$filtered" || true)
versions=$(grep -oE 'Pikos [^ ]+ starting on' "$filtered" | sort -u | wc -l | tr -d ' ')

instance_fault=""
if [ "$starts" -ne "$schedulers" ]; then
  instance_fault="${starts} launch(es) but ${schedulers} scheduler(s)"
elif [ "$versions" -gt 1 ]; then
  instance_fault="$(grep -oE 'Pikos [^ ]+ starting on' "$filtered" | sort -u | tr '\n' ' ')"
fi

if [ -z "$hits" ] && [ -z "$instance_fault" ]; then
  echo "[log-check] clean${SINCE:+ since $SINCE}"
  exit 0
fi

if [ -n "$instance_fault" ]; then
  echo
  echo "[log-check] more than one Pikos ran against this profile: ${instance_fault}"
  echo "  Every launch starts exactly one scheduler, and every launch in a session"
  echo "  reports the same version. Check for a second copy of the app."
fi

if [ -z "$hits" ]; then
  echo
  exit 1
fi

# Collapse ids and timestamps so one recurring line reports as one finding with
# a count, rather than as the 320 copies that make a log unreadable.
echo
echo "[log-check] unaccounted warnings and errors${SINCE:+ since $SINCE}:"
echo
printf '%s\n' "$hits" \
  | sed -E 's/^\[[0-9-]+\]\[[0-9:]+\]//' \
  | sed -E 's/[0-9a-f]{8}-[0-9a-f-]{27}/<id>/g' \
  | sed -E 's/[0-9]+×/<n>×/g' \
  | sort | uniq -c | sort -rn \
  | sed 's/^/  /'
echo
echo "  Fix each one, or add it to EXPECTED with the reason it is not a defect."
echo "  First and last occurrence of each tells you whether it is still live."
echo
exit 1
