#!/usr/bin/env bash
# Fail when a migration that has shipped is no longer byte-for-byte what shipped.
#
# sqlx stores a hash of each applied migration and refuses to open a database whose
# migration file has since changed, so editing a released one, even its comments, locks
# every install that applied it out of its own workspace on the next upgrade, with no way
# back. Every other gate builds the schema from scratch and can't see it. The fix is a new
# migration, never an edit.
#
# Compared against every release tag, betas included, since any of them can be installed.
# Git blob ids are equal exactly when the bytes are, which is what sqlx's hash checks too.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIR="crates/pikos-db/migrations"
cd "$ROOT"

# CI checks out one commit and no tags.
if [ -z "$(git tag --list 'v*')" ]; then
  git fetch --quiet --depth=1 origin '+refs/tags/v*:refs/tags/v*'
fi

changed=""
for tag in $(git tag --list 'v*'); do
  for file in $(git ls-tree --name-only "$tag" "$DIR/"); do
    shipped=$(git rev-parse "$tag:$file")
    if [ ! -f "$file" ]; then
      changed+="  $file was deleted after shipping in $tag"$'\n'
    elif [ "$(git hash-object "$file")" != "$shipped" ]; then
      changed+="  $file differs from what shipped in $tag"$'\n'
    fi
  done
done

if [ -n "$changed" ]; then
  echo "A migration that has shipped was changed:"
  printf '%s' "$changed" | sort -u
  echo "Put it back as it shipped and write the change as a new migration."
  exit 1
fi
echo "[migrations] every shipped migration is as it shipped"
