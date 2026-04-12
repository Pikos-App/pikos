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
    "$@"
}

ts_src_files() {
  src_files | grep -E '\.(ts|tsx|js|jsx)$' | grep -v '\.test\.'
}

rust_src_files() {
  src_files | grep -E '\.rs$'
}

# ── 1. Secrets (gitleaks) ──────────────────────────────────────────────────────
if command -v gitleaks &>/dev/null; then
  if gitleaks dir . --no-banner --exit-code 1 &>/dev/null; then
    pass "No secrets" "gitleaks"
  else
    fail "gitleaks detected secrets — run 'gitleaks dir . -v' for details"
  fi
else
  # Fallback: basic pattern grep if gitleaks not installed
  hits=$(src_files '*.ts' '*.tsx' '*.js' '*.jsx' '*.rs' '*.json' '*.toml' '*.yaml' '*.yml' '*.env*' \
    | xargs grep -nE '(sk-[a-zA-Z0-9]{20,}|ghp_[a-zA-Z0-9]{36,}|AIza[a-zA-Z0-9_-]{35}|AKIA[A-Z0-9]{16}|xoxb-[0-9]|-----BEGIN (RSA |EC |DSA |OPENSSH )?PRIVATE KEY)' 2>/dev/null \
    | grep -v 'node_modules' || true)

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
hits=$(rust_src_files \
  | xargs grep -nE '(^\s*dbg!\(|^\s*println!\()' 2>/dev/null \
  | grep -v '#\[cfg(test)\]' \
  | grep -v '#\[test\]' || true)

if [ -n "$hits" ]; then
  fail "Rust debug leftovers (dbg! / println!)" $hits
else
  pass "No Rust debug leftovers"
fi

# ── 5. Unauthorized network calls ───────────────────────────────────────────
# The desktop app must not make network requests except via the Tauri updater plugin.
hits=$(ts_src_files \
  | xargs grep -nE '\b(fetch\s*\(|axios|XMLHttpRequest|navigator\.sendBeacon|new\s+WebSocket|\.get\s*\(\s*['\''"`]https?://|\.post\s*\(\s*['\''"`]https?://)' 2>/dev/null || true)

rust_hits=$(rust_src_files \
  | xargs grep -nE '\b(reqwest::|hyper::|ureq::|surf::|attohttpc::|isahc::|Client::new|HttpClient)' 2>/dev/null \
  | grep -v 'tauri.plugin' || true)

all_network="$hits$rust_hits"
if [ -n "$all_network" ]; then
  fail "Unauthorized network calls detected" $all_network
else
  pass "No unauthorized network calls"
fi

# ── 6. Analytics / telemetry SDK imports ────────────────────────────────────
hits=$(ts_src_files \
  | xargs grep -nEi '(from ['\''"](@sentry|sentry|mixpanel|posthog|amplitude|@segment|@google-analytics|@fullstory|logrocket|hotjar)|import.*(Sentry|Mixpanel|Posthog|Amplitude)|analytics\.(init|track|identify|page)\(|\bgtag\s*\(|umami\.track)' 2>/dev/null || true)

if [ -n "$hits" ]; then
  fail "Analytics/telemetry SDK references in desktop app" $hits
else
  pass "No analytics/telemetry SDKs"
fi

# ── Summary ─────────────────────────────────────────────────────────────────
echo ""
if [ $overall -eq 0 ]; then
  printf "${GREEN}Source audit passed.${RESET}\n"
else
  printf "${RED}Source audit failed — fix findings before committing.${RESET}\n"
fi

exit $overall
