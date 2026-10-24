#!/usr/bin/env bash
# Fail when Rust code reads a page body from `pages.content` instead of from its chunks.
#
# Every reader gets a body through `page_chunks::body_sql` (PKOS-0192). `content` is still written,
# so a reader left on it returns the right page today and nothing else would notice; it breaks only
# once saves write chunks alone. A read that has to stay on the column, like the upgrade's passes
# or a scan of a backup older than chunks, carries `// body-read-ok: <why>` on the line or within
# two lines of it.
#
# A text scan, so it flags SQL by its shape: a line naming the column beside SQL words, a row read
# of a column called "content", or `SELECT *` from pages without the body. Tests are left out:
# they compare the column with the chunks on purpose.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

hits=$(git ls-files 'crates/*.rs' 'apps/desktop/src-tauri/src/*.rs' \
  | grep -vE '(_tests\.rs|/tests\.rs|/tests/)' \
  | python3 -c '
import re, sys

COLUMN = re.compile(r"\bcontent\b(?!_)")
SQL_WORD = re.compile(r"\b(SELECT|WHERE|FROM|AND|OR|LIKE|ORDER BY|GROUP BY)\b|\binstr\(")
WRITE = re.compile(r"\bINSERT INTO\b|\bSET content\b")
ROW_READ = re.compile(r"try_get(::<[^>]*>)?\(\s*\"content\"")
QUALIFIED = re.compile(r"\bpages\.content\b(?!_)")
SELECT_ALL = re.compile(r"SELECT \*.*\bFROM pages\b")

for path in sys.stdin.read().split("\n"):
    if not path:
        continue
    try:
        lines = open(path, encoding="utf-8").read().splitlines()
    except OSError:
        continue
    for i, line in enumerate(lines):
        code = line.strip()
        if code.startswith("//"):
            continue
        reads_sql = COLUMN.search(code) and SQL_WORD.search(code) and not WRITE.search(code)
        selects_all = SELECT_ALL.search(code) and "body" not in code
        if not (reads_sql or ROW_READ.search(code) or QUALIFIED.search(code) or selects_all):
            continue
        if any("body-read-ok:" in w for w in lines[max(0, i - 2) : i + 3]):
            continue
        print("  {}:{}: {}".format(path, i + 1, code))
')

if [ -n "$hits" ]; then
  echo "A page body is read from pages.content rather than its chunks:"
  printf '%s\n' "$hits"
  echo "Read it through page_chunks::body_sql, or mark a read that must stay with '// body-read-ok: <why>'."
  exit 1
fi
echo "[body-reads] every page body is read from its chunks"
