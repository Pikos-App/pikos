# Sourced by scripts/verify.sh and the git hooks. Turbo's cache defaults to each checkout's own
# folder, so a fresh worktree's first verify reran every task another worktree had already passed.
# The common git dir is the one folder every worktree shares. CI keeps the default, which its
# cache step saves and restores.
if [ -z "$CI" ] && [ -z "$TURBO_CACHE_DIR" ]; then
  TURBO_CACHE_DIR="$(git rev-parse --path-format=absolute --git-common-dir)/turbo-cache" && export TURBO_CACHE_DIR
fi
