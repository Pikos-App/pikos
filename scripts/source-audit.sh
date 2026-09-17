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

# Only check tracked files in source directories (skip node_modules, dist, target, etc.)
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

# Every outbound request clones the shared client built here, so this is the one
# file where a client may be constructed and the only place TLS, timeouts and the
# user-agent are set.
HTTP_CHOKEPOINT='crates/pikos-calendar-sync/src/http.rs'
SYNC_CRATE='crates/pikos-calendar-sync/'

# ── 1. Secrets (gitleaks) ──────────────────────────────────────────────────────
if command -v gitleaks &>/dev/null; then
  if gitleaks dir . --no-banner --exit-code 1 &>/dev/null; then
    pass "No secrets" "gitleaks"
  else
    fail "gitleaks detected secrets — run 'gitleaks dir . -v' for details"
  fi
else
  # Fallback: basic pattern grep if gitleaks not installed
  # packages/recurrence-wasm/pkg is generated (base64-embedded wasm binary);
  # random token-shaped substrings in the blob trip the patterns.
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

# ── 2. Hardcoded personal paths ─────────────────────────────────────────────
hits=$(src_files \
  | xargs grep -nE '(/Users/[a-zA-Z]|/home/[a-zA-Z]|/Library/Application Support|\.ssh/|\.aws/|\.gnupg/)' 2>/dev/null \
  | grep -v '\.rs:.*//.*e\.g\.' \
  | grep -v 'node_modules' || true)

if [ -n "$hits" ]; then
  fail "Hardcoded personal paths" $hits
else
  pass "No hardcoded personal paths"
fi

# ── 3. Debug leftovers (JS/TS) ──────────────────────────────────────────────
hits=$(ts_src_files \
  | xargs grep -nE '(^\s*console\.log\(|^\s*debugger\b)' 2>/dev/null || true)

if [ -n "$hits" ]; then
  fail "JS/TS debug leftovers (console.log / debugger)" $hits
else
  pass "No JS/TS debug leftovers"
fi

# ── 4. Debug leftovers (Rust) ───────────────────────────────────────────────
hits=$(app_rust_src_files \
  | xargs grep -nE '(^\s*dbg!\(|^\s*println!\()' 2>/dev/null \
  | grep -v '#\[cfg(test)\]' \
  | grep -v '#\[test\]' || true)

if [ -n "$hits" ]; then
  fail "Rust debug leftovers (dbg! / println!)" $hits
else
  pass "No Rust debug leftovers"
fi

# ── 5. Unauthorized network calls ───────────────────────────────────────────
# The desktop app must not make network requests except via the Tauri updater
# plugin. Calendar sync is the single exception, and it is fenced three ways:
# only that crate may declare an HTTP client, only its chokepoint may construct
# one, and no other Rust source may name one at all.
hits=$(ts_src_files \
  | xargs grep -nE '\b(fetch\s*\(|axios|XMLHttpRequest|navigator\.sendBeacon|new\s+WebSocket|\.get\s*\(\s*['\''"`]https?://|\.post\s*\(\s*['\''"`]https?://)' 2>/dev/null || true)

rust_hits=$(rust_src_files \
  | grep -v "^$SYNC_CRATE" \
  | xargs grep -nE '\b(reqwest::|hyper::|ureq::|surf::|attohttpc::|isahc::|Client::new|HttpClient)' 2>/dev/null \
  | grep -v 'tauri.plugin' || true)

build_hits=$(rust_src_files \
  | grep "^$SYNC_CRATE" \
  | grep -v "^$HTTP_CHOKEPOINT$" \
  | xargs grep -nE '(reqwest::Client(Builder)?::(builder|new)[[:space:]]*\(|^[[:space:]]*use[[:space:]]+reqwest::.*Client)' 2>/dev/null || true)

dep_hits=$(git ls-files -- 'Cargo.toml' '*/Cargo.toml' \
  | grep -v "^${SYNC_CRATE}Cargo.toml$" \
  | xargs grep -nE '^[[:space:]]*(reqwest|hyper|ureq|surf|attohttpc|isahc)[[:space:]]*=' 2>/dev/null || true)

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

# ── 6. Analytics / telemetry SDK imports ────────────────────────────────────
hits=$(ts_src_files \
  | xargs grep -nEi '(from ['\''"](@sentry|sentry|mixpanel|posthog|amplitude|@segment|@google-analytics|@fullstory|logrocket|hotjar)|import.*(Sentry|Mixpanel|Posthog|Amplitude)|analytics\.(init|track|identify|page)\(|\bgtag\s*\(|umami\.track)' 2>/dev/null || true)

if [ -n "$hits" ]; then
  fail "Analytics/telemetry SDK references in desktop app" $hits
else
  pass "No analytics/telemetry SDKs"
fi

# ── 7. XSS vectors (eval, innerHTML, dangerouslySetInnerHTML) ───────────────
# In a Tauri app, XSS can escalate to full system access via IPC.
# Exclude comments (lines starting with optional whitespace then // or * or /*).
hits=$(ts_src_files \
  | xargs grep -nE '(\beval\s*\(|new\s+Function\s*\(|\binnerHTML\s*=|dangerouslySetInnerHTML)' 2>/dev/null \
  | grep -vE '^\S+:\s*(//|\*|/\*)' || true)

if [ -n "$hits" ]; then
  fail "XSS vectors (eval/innerHTML/dangerouslySetInnerHTML)" $hits
else
  pass "No XSS vectors"
fi

# ── 8. Unsafe Rust ─────────────────────────────────────────────────────────
hits=$(rust_src_files \
  | xargs grep -nE '^\s*unsafe\b' 2>/dev/null \
  | grep -v '#\[cfg(test)\]' \
  | grep -v '// SAFETY:' || true)

if [ -n "$hits" ]; then
  fail "Unsafe Rust blocks (add '// SAFETY:' comment if intentional)" $hits
else
  pass "No unsafe Rust"
fi

# ── 9. SQL injection (raw string queries in Rust) ──────────────────────────
# All SQL must use sqlx parameterized queries (?-binds). Flag any sqlx entry
# point invoked with a `format!`'d string — query/query_as/query_scalar/execute.
# Dynamic WHERE clauses built via QueryBuilder.push_bind are safe.
# To allow a call site where the interpolated value is a compile-time constant
# (e.g. column whitelist, PRAGMA name), add `// sql-ok:` by the call: the line
# above it, the line itself, or either of the two after, since `format!(` wraps.
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
        # The annotation sits wherever it reads best: above the call, on it, or
        # inside it, since format!( almost always wraps.
        if any("sql-ok:" in w for w in lines[max(0, i - 1) : i + 3]):
            continue
        print("{}:{}:{}".format(path, i + 1, line.strip()))
' 2>/dev/null || true)

if [ -n "$hits" ]; then
  fail "Possible SQL injection (use sqlx parameterized queries or add '// sql-ok:' if interpolated value is constant)" $hits
else
  pass "No raw SQL string interpolation"
fi

# ── 10. Tauri capability escalation ─────────────────────────────────────────
# Flag high-risk permissions that should never appear without explicit review.
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

# ── Summary ─────────────────────────────────────────────────────────────────
echo ""
if [ $overall -eq 0 ]; then
  printf "${GREEN}Source audit passed.${RESET}\n"
else
  printf "${RED}Source audit failed — fix findings before committing.${RESET}\n"
fi

exit $overall
