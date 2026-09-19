#!/usr/bin/env python3
"""Footnote integrity check for docs/functionality-matrix.md.

The matrix carries ~80 superscript footnotes. Editing a cell by hand is easy;
leaving a marker pointing at a definition that no longer exists — or renumbering
one section and not the rest — is easier. Nothing else catches that, so run this
after any edit that touches a footnote:

    python3 scripts/check-doc-footnotes.py

Exits non-zero on any violation. The invariants:
  - every marker used in a cell has exactly one definition, and vice versa
  - definitions appear in ascending order
  - a footnote's first *reference* also appears in ascending order, so the
    numbering still reads top-to-bottom
  - the numbers are contiguous from 1 (a gap means a botched renumber)

A definition is a line starting with its superscript marker; everything else on
a line counts as a reference.
"""

import re
import sys
from collections import Counter
from pathlib import Path

SUP = "⁰¹²³⁴⁵⁶⁷⁸⁹"
TO_DIGIT = {c: str(i) for i, c in enumerate(SUP)}
TOKEN = re.compile(f"[{SUP}]+")
DEFINITION = re.compile(f"^([{SUP}]+) ")

DEFAULT_TARGET = Path(__file__).resolve().parent.parent / "docs" / "functionality-matrix.md"


def to_int(token: str) -> int:
    return int("".join(TO_DIGIT[c] for c in token))


def check(path):
    definitions = Counter()
    definition_order = []
    first_reference = []

    for line in path.read_text(encoding="utf-8").splitlines():
        match = DEFINITION.match(line)
        if match:
            number = to_int(match.group(1))
            definitions[number] += 1
            definition_order.append(number)
            rest = line[match.end(1) :]
        else:
            rest = line
        for token in TOKEN.findall(rest):
            number = to_int(token)
            if number not in first_reference:
                first_reference.append(number)

    if not definitions:
        return [f"{path}: no footnotes found — wrong file?"]

    errors = []
    for number, count in sorted(definitions.items()):
        if count > 1:
            errors.append(f"footnote {number} defined {count} times")
    for number in sorted(set(first_reference) - set(definitions)):
        errors.append(f"footnote {number} referenced but never defined")
    for number in sorted(set(definitions) - set(first_reference)):
        errors.append(f"footnote {number} defined but never referenced")
    if definition_order != sorted(definition_order):
        errors.append("definitions are out of ascending order")
    if first_reference != sorted(first_reference):
        out_of_order = [b for a, b in zip(first_reference, first_reference[1:]) if a > b]
        errors.append(f"first references out of ascending order at: {out_of_order}")
    missing = sorted(set(range(1, max(definitions) + 1)) - set(definitions))
    if missing:
        errors.append(f"gaps in the sequence: {missing}")

    if not errors:
        print(f"{path.name}: {len(definitions)} footnotes, 1–{max(definitions)}, all invariants hold")
    return errors


if __name__ == "__main__":
    target = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_TARGET
    problems = check(target)
    for problem in problems:
        print(f"FAIL {problem}", file=sys.stderr)
    sys.exit(1 if problems else 0)
