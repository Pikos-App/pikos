#!/usr/bin/env bash
# Source audit: catches accidental secrets, debug leftovers, personal info,
# unauthorized network calls, and analytics stubs before they're committed.
# Called from .husky/pre-commit. Fast (<10s with gitleaks, <2s without).

set -o pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
DIM='\033[2m'
RESET='\033[0m'

overall=0

pass() { printf "${GREEN}✓${RESET} %s${DIM} %s${RESET}\n" "$1" "$2"; }
fail() {
  printf "${RED}✗${RESET} %s\n" "$1"
  shift
  printf "  %s\n" "$@"
  overall=1
}

src_files() {
  git ls-files -- \
    'apps/desktop/src/**' \
    'apps/desktop/src-tauri/src/**' \
    'packages/core/src/**' \
    'packages/ui/src/**' \
    'crates/*/src/**' \
    "$@"
}

ts_src_files() {
  src_files | grep -E '\.(ts|tsx|js|jsx)$' | grep -v '\.test\.'
}

rust_src_files() {
  src_files | grep -E '\.rs$'
}

# The CLI's whole output is println!, so it is the one crate exempt from the
# debug-leftover check.
app_rust_src_files() {
  rust_src_files | grep -v '^crates/pikos-cli/'
}

# `docs/` ships, so a pointer into a gitignored record is as dead there as in
# source, and check-doc-footnotes.py only counts footnote markers. Kept out of
# src_files because every other check in this script is about code.
published_docs() {
  git ls-files -- 'docs/**' | grep -E '\.md$'
}

# Every outbound request clones the shared client built here, so this is the one
# file where a client may be constructed and the only place TLS, timeouts and the
# user-agent are set.
HTTP_CHOKEPOINT='crates/pikos-calendar-sync/src/http.rs'
SYNC_CRATE='crates/pikos-calendar-sync/'

# The browser test lane's writer: a server on localhost that answers the test page
# and sends nothing out. It and its server-only, optional `hyper` compile only under
# the `e2e-bridge` feature, which CI's test job enables and no release build does.
E2E_BRIDGE='apps/desktop/src-tauri/src/e2e_bridge.rs'

# At commit time the hook sets SOURCE_AUDIT_STAGED and only staged changes are scanned: they are
# what is about to enter history, and scanning the tree read about 5 GB of ignored build output
# (two and a half minutes per commit). Elsewhere the whole tree is scanned.
if [ -n "${SOURCE_AUDIT_STAGED:-}" ]; then
  gitleaks_scan=(git --pre-commit --staged)
else
  gitleaks_scan=(dir .)
fi
if command -v gitleaks &>/dev/null; then
  if gitleaks "${gitleaks_scan[@]}" --no-banner --exit-code 1 &>/dev/null; then
    pass "No secrets" "gitleaks ${gitleaks_scan[*]}"
  else
    fail "gitleaks detected secrets — run 'gitleaks ${gitleaks_scan[*]} -v' for details"
  fi
else
  # packages/recurrence-wasm/pkg is generated (base64 wasm), and random token-shaped substrings in
  # it trip these patterns.
  hits=$(src_files '*.ts' '*.tsx' '*.js' '*.jsx' '*.rs' '*.json' '*.toml' '*.yaml' '*.yml' '*.env*' \
    | xargs grep -nE '(sk-[a-zA-Z0-9]{20,}|ghp_[a-zA-Z0-9]{36,}|AIza[a-zA-Z0-9_-]{35}|AKIA[A-Z0-9]{16}|xoxb-[0-9]|-----BEGIN (RSA |EC |DSA |OPENSSH )?PRIVATE KEY)' 2>/dev/null \
    | grep -v 'node_modules' \
    | grep -v 'packages/recurrence-wasm/pkg/' || true)

  if [ -n "$hits" ]; then
    fail "Possible secrets detected (install gitleaks for better coverage)" $hits
  else
    pass "No secrets" "fallback grep (install gitleaks for 800+ patterns)"
  fi
fi

hits=$(src_files \
  | xargs grep -nE '(/Users/[a-zA-Z]|/home/[a-zA-Z]|/Library/Application Support|\.ssh/|\.aws/|\.gnupg/)' 2>/dev/null \
  | grep -v '\.rs:.*//.*e\.g\.' \
  | grep -v 'node_modules' || true)

if [ -n "$hits" ]; then
  fail "Hardcoded personal paths" $hits
else
  pass "No hardcoded personal paths"
fi

# `.agent/` and `.claude/` are gitignored, so a decision-record id, a backlog id or a path into
# them is a dead end for readers of the published source. State the fact inline.
hits=$({ src_files; published_docs; } \
  | xargs grep -nE '(PKOS-[0-9]{4}|GAR-[0-9]{4}|SOLO-[0-9]{4}|\.agent/|\.claude/|`[A-Z][0-9]{1,3}`)' 2>/dev/null \
  | grep -v 'node_modules' || true)

if [ -n "$hits" ]; then
  fail "References to gitignored records or paths" $hits
else
  pass "No references nobody outside can follow"
fi

# A comment states what is true now. A version tag or a word of history in one is a change log
# that goes stale; the history belongs in git and the decision in its record. Narrow on purpose:
# "no longer" and "now" also describe present behaviour, so they aren't matched.
hits=$(src_files 'apps/ios/**' 'apps/apple/**' \
  | grep -E '\.(ts|tsx|rs|swift)$' \
  | grep -vE '(/generated/|/pkg/|PikosCore/Sources/PikosCore/)' \
  | xargs grep -nE '^\s*(//|\*|/\*).*(\(v?[0-9]+\.[0-9]+(\.[0-9]+)?\)|\b(in|since) v?[0-9]+\.[0-9]+\.[0-9]+\b|\b(previously|used to be|until recently)\b)' 2>/dev/null \
  || true)

if [ -n "$hits" ]; then
  fail "Comments carrying version tags or history (say what is true now)" $hits
else
  pass "No history in comments"
fi

hits=$(ts_src_files \
  | xargs grep -nE '(^\s*console\.log\(|^\s*debugger\b)' 2>/dev/null || true)

if [ -n "$hits" ]; then
  fail "JS/TS debug leftovers (console.log / debugger)" $hits
else
  pass "No JS/TS debug leftovers"
fi

hits=$(app_rust_src_files \
  | xargs grep -nE '(^\s*dbg!\(|^\s*println!\()' 2>/dev/null \
  | grep -v '#\[cfg(test)\]' \
  | grep -v '#\[test\]' || true)

if [ -n "$hits" ]; then
  fail "Rust debug leftovers (dbg! / println!)" $hits
else
  pass "No Rust debug leftovers"
fi

# The desktop app makes no network requests except via the Tauri updater plugin. Calendar sync is
# the one exception, fenced three ways: only that crate may declare an HTTP client, only its
# chokepoint may construct one, and no other Rust source may name one.
hits=$(ts_src_files \
  | xargs grep -nE '\b(fetch\s*\(|axios|XMLHttpRequest|navigator\.sendBeacon|new\s+WebSocket|\.get\s*\(\s*['\''"`]https?://|\.post\s*\(\s*['\''"`]https?://)' 2>/dev/null || true)

rust_hits=$(rust_src_files \
  | grep -v "^$SYNC_CRATE" \
  | grep -v "^$E2E_BRIDGE$" \
  | xargs grep -nE '\b(reqwest::|hyper::|ureq::|surf::|attohttpc::|isahc::|Client::new|HttpClient)' 2>/dev/null \
  | grep -v 'tauri.plugin' || true)

build_hits=$(rust_src_files \
  | grep "^$SYNC_CRATE" \
  | grep -v "^$HTTP_CHOKEPOINT$" \
  | xargs grep -nE '(reqwest::Client(Builder)?::(builder|new)[[:space:]]*\(|^[[:space:]]*use[[:space:]]+reqwest::.*Client)' 2>/dev/null || true)

dep_hits=$(git ls-files -- 'Cargo.toml' '*/Cargo.toml' \
  | grep -v "^${SYNC_CRATE}Cargo.toml$" \
  | xargs grep -nE '^[[:space:]]*(reqwest|hyper|ureq|surf|attohttpc|isahc)[[:space:]]*=' 2>/dev/null \
  | grep -vE '^apps/desktop/src-tauri/Cargo\.toml:[0-9]+:hyper = \{ version = "1", features = \["http1", "server"\], optional = true \}$' || true)

all_network="$hits$rust_hits"
if [ -n "$all_network" ]; then
  fail "Unauthorized network calls detected" $all_network
else
  pass "No unauthorized network calls" "outside the sync crate"
fi

if [ -n "$build_hits" ]; then
  fail "HTTP client built outside $HTTP_CHOKEPOINT (clone the shared client instead)" $build_hits
else
  pass "One HTTP client chokepoint"
fi

if [ -n "$dep_hits" ]; then
  fail "HTTP client dependency outside the sync crate" $dep_hits
else
  pass "One crate depends on an HTTP client"
fi

# The workspace leaves the device for the person's iCloud private database only through the sync
# package. The phone's sync wiring imports CloudKit to name the container and hands it straight on.
hits=$(git ls-files -- '*.swift' \
  | grep -v '^apps/apple/PikosSync/' \
  | grep -v '^apps/ios/Pikos/Sources/Sync/' \
  | xargs grep -nE '^[[:space:]]*(@[a-zA-Z]+[[:space:]]+)*import[[:space:]]+CloudKit\b' 2>/dev/null || true)

if [ -n "$hits" ]; then
  fail "CloudKit imported outside the sync package" $hits
else
  pass "CloudKit only in the sync package"
fi

hits=$(ts_src_files \
  | xargs grep -nEi '(from ['\''"](@sentry|sentry|mixpanel|posthog|amplitude|@segment|@google-analytics|@fullstory|logrocket|hotjar)|import.*(Sentry|Mixpanel|Posthog|Amplitude)|analytics\.(init|track|identify|page)\(|\bgtag\s*\(|umami\.track)' 2>/dev/null || true)

if [ -n "$hits" ]; then
  fail "Analytics/telemetry SDK references in desktop app" $hits
else
  pass "No analytics/telemetry SDKs"
fi

# In a Tauri app, XSS can escalate to full system access via IPC.
hits=$(ts_src_files \
  | xargs grep -nE '(\beval\s*\(|new\s+Function\s*\(|\binnerHTML\s*=|dangerouslySetInnerHTML)' 2>/dev/null \
  | grep -vE '^\S+:\s*(//|\*|/\*)' || true)

if [ -n "$hits" ]; then
  fail "XSS vectors (eval/innerHTML/dangerouslySetInnerHTML)" $hits
else
  pass "No XSS vectors"
fi

hits=$(rust_src_files \
  | xargs grep -nE '^\s*unsafe\b' 2>/dev/null \
  | grep -v '#\[cfg(test)\]' \
  | grep -v '// SAFETY:' || true)

if [ -n "$hits" ]; then
  fail "Unsafe Rust blocks (add '// SAFETY:' comment if intentional)" $hits
else
  pass "No unsafe Rust"
fi

# All SQL must use sqlx parameterized binds. Flags a sqlx entry point called with a `format!`'d
# string; QueryBuilder.push_bind is safe. For a compile-time-constant interpolation (column
# whitelist, PRAGMA name), add `// sql-ok:` on the line above the call, on it, or in the two
# after, since `format!(` wraps.
hits=$(rust_src_files | python3 -c '
import re, sys

CALL = re.compile(r"\b(execute|query|query_as|query_scalar)(::<[^>]+>)?\s*\(\s*&?format!")

for path in sys.stdin.read().split("\n"):
    if not path:
        continue
    try:
        lines = open(path, encoding="utf-8").read().splitlines()
    except OSError:
        continue
    for i, line in enumerate(lines):
        if not CALL.search(line):
            continue
        if any("sql-ok:" in w for w in lines[max(0, i - 1) : i + 3]):
            continue
        print("{}:{}:{}".format(path, i + 1, line.strip()))
' 2>/dev/null || true)

if [ -n "$hits" ]; then
  fail "Possible SQL injection (use sqlx parameterized queries or add '// sql-ok:' if interpolated value is constant)" $hits
else
  pass "No raw SQL string interpolation"
fi

cap_files=$(git ls-files -- 'apps/desktop/src-tauri/capabilities/*.json')
if [ -n "$cap_files" ]; then
  hits=$(echo "$cap_files" \
    | xargs grep -nEi '(shell:execute|shell:allow-execute|shell:allow-open|fs:allow-write-all|fs:allow-rename|http:default|http:allow-fetch)' 2>/dev/null || true)

  if [ -n "$hits" ]; then
    fail "High-risk Tauri capabilities detected" $hits
  else
    pass "No high-risk Tauri capabilities"
  fi
else
  pass "No high-risk Tauri capabilities" "(no capability files)"
fi

echo ""
if [ $overall -eq 0 ]; then
  printf "${GREEN}Source audit passed.${RESET}\n"
else
  printf "${RED}Source audit failed — fix findings before committing.${RESET}\n"
fi

exit $overall
