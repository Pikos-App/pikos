#!/usr/bin/env python3
"""The row ids of docs/functionality-matrix.md, and the check that holds them.

    python3 scripts/matrix_rows.py

A row's id (`F12`) is permanent, so a screen tour shot can cite the rows it shows and the tour's
PDF can say which rows no shot shows. Exits non-zero when a row has no id, two rows share one, or
the desktop tour cites an id the matrix no longer has: without that last check, rewording or
deleting a row would leave the tour pointing at nothing and nobody would notice.
"""

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MATRIX = ROOT / "docs" / "functionality-matrix.md"
TOUR = ROOT / "apps" / "desktop" / "e2e" / "screen-tour.spec.ts"

SECTION = re.compile(r"^## (\d+)\. (.+)$")
ROW_ID = re.compile(r"^F\d+$")
CITED = re.compile(r'"(F\d+)"')


def cells(line: str) -> list[str]:
    return [cell.strip() for cell in line.strip().strip("|").split("|")]


def rows(path: Path = MATRIX) -> list[dict]:
    """Every row of the numbered sections' tables, as its id, its operation and its section."""
    found, section, previous = [], None, ""
    for line in path.read_text(encoding="utf-8").splitlines():
        if match := SECTION.match(line):
            section = f"{match[1]}. {match[2]}"
        elif line.startswith("## "):
            section = None
        is_body_row = section and line.startswith("|") and previous.startswith("|")
        if is_body_row and not set(line) <= set("|- "):
            first, name = cells(line)[:2]
            found.append({"id": first, "name": name, "section": section})
        previous = line
    return found


def check() -> list[str]:
    errors, seen = [], set()
    for row in rows():
        if not ROW_ID.match(row["id"]):
            errors.append(f"a row in {row['section']} has no id: {row['name'] or row['id']}")
        elif row["id"] in seen:
            errors.append(f"{row['id']} names two rows")
        seen.add(row["id"])

    for cited in sorted(set(CITED.findall(TOUR.read_text(encoding="utf-8")))):
        if cited not in seen:
            errors.append(f"the screen tour cites {cited}, which the matrix has no row for")
    return errors


if __name__ == "__main__":
    problems = check()
    for problem in problems:
        print(f"FAIL {problem}", file=sys.stderr)
    sys.exit(1 if problems else 0)
