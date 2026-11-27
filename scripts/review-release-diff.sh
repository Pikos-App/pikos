#!/usr/bin/env bash
# Have one agent read what a release changes, for what no gate checks.
#
#   scripts/review-release-diff.sh [base] [-- path ...]
#
# Reads the diff from base (default: the newest v* tag) to HEAD, limited to the paths if any are
# given: `scripts/review-release-diff.sh main -- crates/pikos-db/src/replica` reviews a sync change
# before it merges. release.sh runs it on the whole release.
#
# The gates already check types, lint, formatting, bindings, migrations and copy, so the agent
# looks only for what they can't see. Findings land in build/release-review/findings.md for a
# person to triage; nothing is filed.
#
#   RELEASE_REVIEW_MODEL=sonnet   cheaper pass; default is opus, since judgment is the job
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
BASE="${1:-$(git describe --tags --abbrev=0 --match 'v*')}"
[ "${1:-}" = "--" ] && BASE="$(git describe --tags --abbrev=0 --match 'v*')"
PATHS=()
while [ $# -gt 0 ]; do
  if [ "$1" = "--" ]; then
    shift
    PATHS=("$@")
    break
  fi
  shift
done
OUT="$ROOT/build/release-review"
MODEL="${RELEASE_REVIEW_MODEL:-opus}"

if ! command -v claude &>/dev/null; then
  echo "claude is not on PATH." >&2
  exit 1
fi
if ! git rev-parse --verify --quiet "$BASE^{commit}" >/dev/null; then
  echo "No commit named $BASE to review from." >&2
  exit 1
fi

mkdir -p "$OUT"
RANGE="$BASE..HEAD"
SCOPE="${PATHS[*]:-the whole repo}"
git diff --stat "$RANGE" -- ${PATHS[@]+"${PATHS[@]}"} > "$OUT/stat.txt"
if [ ! -s "$OUT/stat.txt" ]; then
  echo "Nothing changed in $RANGE for $SCOPE."
  exit 0
fi

echo "Reviewing $RANGE ($SCOPE) with $MODEL."
claude -p \
  --model "$MODEL" \
  --allowedTools "Read" "Grep" "Glob" "Bash(git diff:*)" "Bash(git log:*)" "Bash(git show:*)" \
  --permission-mode dontAsk \
  "You are reviewing what a Pikos release changes, before it ships to people's devices. Pikos is a
local-first notes, tasks and calendar app: a Tauri desktop app and a SwiftUI iPhone app over one
Rust core, with iCloud sync between a person's devices. Read AGENTS.md first.

The range is $RANGE, limited to $SCOPE. $OUT/stat.txt lists the files. Read the diffs with
git diff and git show, and the surrounding code with Read and Grep.

Look only for what no automated gate catches. Types, lint, formatting, generated bindings,
frozen migrations and copy rules are already enforced, so say nothing about them. Look for:

1. Sync and data loss. A change that could lose, duplicate or resurrect a person's data, or make
   two devices disagree: replica capture and apply, tombstones, the holding pen, conflict rules,
   migrations that rewrite rows, anything under crates/pikos-db/src/replica.
2. Behaviour changed without a test. A user-visible change whose diff adds or changes no test
   that would fail without it.
3. The Mac and the phone diverging. The same action now behaving differently on the two apps
   when nothing says that's intended.
4. Security and privacy. Data leaving the device, a new network call, a secret or path in a log,
   an input reaching SQL, HTML or a shell.

For each finding give the file and line, what goes wrong for a person, and how sure you are.
Skip style and anything speculative you can't point at. If you find nothing in a category, say
so in one line. Answer in markdown, findings first, most serious first." \
  > "$OUT/findings.md" 2>"$OUT/review.err" || {
    echo "The review failed; see $OUT/review.err" >&2
    exit 1
  }

echo "$OUT/findings.md"
