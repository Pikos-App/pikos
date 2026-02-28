---
name: gh-fix-ci
description: Debug and fix failing GitHub Actions CI checks on a pull request or branch. Use when CI is red and you need to identify the failure, understand the error, and propose a fix.
compatibility: Claude Code with gh CLI authenticated (gh auth login --scopes workflow,repo)
---

# Fix Failing CI

## Prerequisite

```bash
gh auth status  # confirm authenticated
# If not: gh auth login --scopes workflow,repo
```

## Step 1 — Identify failing checks

```bash
# For a PR:
gh pr checks <pr-number>

# For the current branch:
gh run list --branch $(git branch --show-current) --limit 5
```

## Step 2 — Get the failure logs

```bash
# Get the run ID from step 1, then:
gh run view <run-id> --log-failed
```

This prints only the failing steps. Look for the first error — subsequent failures are often cascading.

## Step 3 — Categorize the failure

| Symptom | Likely cause |
|---------|-------------|
| `error TS...` | TypeScript type error — fix in source, not in tsconfig |
| `biome check` failed | Format or lint violation — run `biome check --write` locally |
| `vitest` test failure | Test assertion failed — read the diff carefully |
| `playwright` failure | UI test failed — check the uploaded artifact for screenshots |
| `pnpm install --frozen-lockfile` failed | Lockfile out of sync — run `pnpm install` and commit `pnpm-lock.yaml` |
| `tsc --noEmit` failed | Type error — see TS errors above |
| `command not found` | Missing dep or wrong pnpm filter name |

## Step 4 — Propose a fix

Before touching any code:
1. State what the failure is and why it's happening
2. Describe the fix
3. Confirm with the user before implementing

## Step 5 — Verify locally

After fixing, run the equivalent check locally before pushing:

```bash
# Biome
pnpm --filter @pikos/desktop biome check src/

# TypeScript
pnpm --filter @pikos/desktop tsc --noEmit
pnpm --filter @pikos/core tsc --noEmit

# Unit tests
pnpm --filter @pikos/core vitest run

# E2E tests
pnpm --filter @pikos/desktop playwright test
```

Or run all checks via lefthook before pushing:
```bash
pnpm lefthook run pre-commit
pnpm lefthook run pre-push
```

## CI workflow location

`.github/workflows/ci.yml` — three jobs: `quality` → `test` → `build`.
