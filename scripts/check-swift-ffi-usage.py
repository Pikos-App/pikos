#!/usr/bin/env python3
"""Check the iOS app's calls against the generated Swift bindings.

CI already regenerates the bindings from the Rust FFI and fails on a diff, so
the bindings cannot drift from the Rust. Nothing checked the other half: that
the *app* still matches the bindings. Rename a field, reorder a record, drop a
method, and the bindings update cleanly while every call site that used the old
shape stays broken until somebody opens Xcode.

Swift is strict about all three things this checks, and each is easy to get
wrong writing code without a compiler:

  * argument labels must exist on the callee,
  * they must appear in declaration order, and
  * an enum case must be spelled exactly as declared.

The third was added after `if case .notFound = error` sat in the tree for
weeks. UniFFI spells an error case as the Rust variant is spelled — `NotFound`,
capitalised — and Swift's own convention is lowerCamelCase, so the wrong
spelling is the one a Swift author writes from habit. It compiles nowhere and
nothing here noticed.

This is text analysis, not a type checker. It will not catch a wrong type, a
missing `await`, or anything about SwiftUI — it catches stale call sites, which
is the failure this repo can actually have without a Mac in the loop.

    python3 scripts/check-swift-ffi-usage.py
"""

from __future__ import annotations

import pathlib
import re
import sys

REPO = pathlib.Path(__file__).resolve().parent.parent
BINDINGS = REPO / "apps/ios/PikosCore/Sources/PikosCore/PikosCore.swift"
SOURCE_ROOTS = [REPO / "apps/ios"]
# The generated bindings describe themselves; checking them against themselves
# proves nothing and reports every internal helper as a mismatch.
SKIP = ("PikosCore/Sources/PikosCore", "/generated/")


def strip_comments(text: str) -> str:
    """Drop block comments, which uniffi interleaves with parameter lists."""
    return re.sub(r"/\*.*?\*/", "", text, flags=re.S)


def labels_of(signature: str) -> list[str]:
    """Parameter labels of a Swift signature, in declaration order."""
    out = []
    for part in strip_comments(signature).split(","):
        if ":" not in part:
            continue
        # Back-quotes come off: uniffi wraps a label that collides with a
        # Swift keyword (`repeat`, `default`, `in`), and the call site may
        # write it either way. Comparing the quoted form against an unquoted
        # one reports a mismatch that is not there.
        label = part.split(":")[0].strip().strip("`")
        if re.fullmatch(r"\w+", label):
            out.append(label)
    return out


def read_enum_cases(bindings: str) -> dict[str, set[str]]:
    """Case names of every public enum the bindings expose.

    Keyed by enum name, so a case spelled for one enum is not accepted for
    another. Payload parentheses are dropped — what is checked is the name.
    """
    cases: dict[str, set[str]] = {}
    for match in re.finditer(r"public\s+enum (\w+)[^{]*\{(.*?)\n\}", bindings, re.S):
        name, body = match.group(1), strip_comments(match.group(2))
        found = set(re.findall(r"^\s*case (\w+)", body, re.M))
        if found:
            cases[name] = found
    return cases


def check_enum_cases(sources: list[pathlib.Path], cases: dict[str, set[str]]) -> list[str]:
    """Flag `case .x` matches whose spelling no enum declares.

    Deliberately permissive: a bare `.something` could belong to any type, and
    this has no type information. So a spelling is accepted when *some* enum
    declares it, and flagged only when one differs from a declared case by case
    alone — which is precisely the mistake being hunted and almost never a
    legitimate `.padding` or `.leading`.
    """
    declared = {case for names in cases.values() for case in names}
    folded = {case.lower(): case for case in declared}

    problems: list[str] = []
    for path in sources:
        for match in re.finditer(r"case\s+\.(\w+)\b", path.read_text()):
            used = match.group(1)
            if used in declared:
                continue
            correct = folded.get(used.lower())
            if correct is not None:
                problems.append(
                    f"{path.relative_to(REPO)}: `case .{used}` — the bindings declare"
                    f" `{correct}`, and Swift matches a case by its exact spelling"
                )
    return problems


def read_api(bindings: str) -> tuple[dict[str, list[str]], dict[str, list[str]]]:
    """Record initialisers and method signatures the bindings expose."""
    inits: dict[str, list[str]] = {}
    for match in re.finditer(r"public struct (\w+)[^{]*\{(.*?)\n\}", bindings, re.S):
        name, body = match.group(1), match.group(2)
        initialiser = re.search(r"public init\((.*?)\)\s*\{", body, re.S)
        if initialiser:
            inits[name] = labels_of(initialiser.group(1))

    methods: dict[str, list[str]] = {}
    for match in re.finditer(
        r"^\s*(?:open|public) func (\w+)\((.*?)\)\s*(?:async\s*)?(?:throws\s*)?(?:->|\{)",
        bindings,
        re.M | re.S,
    ):
        methods.setdefault(match.group(1), labels_of(match.group(2)))
    return inits, methods


def balanced_args(source: str, open_paren: int) -> str | None:
    """The text inside the parens starting at `open_paren`, nesting respected."""
    depth = 0
    for i in range(open_paren, len(source)):
        if source[i] == "(":
            depth += 1
        elif source[i] == ")":
            depth -= 1
            if depth == 0:
                return source[open_paren + 1 : i]
    return None


def top_level_labels(args: str) -> list[str]:
    """Labels at nesting depth zero.

    `createPage(page: NewPage(title: t))` passes one labelled argument, not two
    — a naive scan reads `title` as an argument to `createPage` and reports a
    mismatch that is not there.
    """
    out: list[str] = []
    depth, token, expecting = 0, "", True
    for char in args:
        if char in "([{":
            depth += 1
        elif char in ")]}":
            depth -= 1
        elif char == "," and depth == 0:
            expecting, token = True, ""
            continue
        elif char == ":" and depth == 0 and expecting:
            label = token.strip().strip("`")
            if re.fullmatch(r"\w+", label):
                out.append(label)
            expecting, token = False, ""
            continue
        if depth == 0 and expecting:
            token += char
    return out


def main() -> int:
    if not BINDINGS.exists():
        print(f"error: {BINDINGS.relative_to(REPO)} is missing — run scripts/gen-swift-bindings.sh")
        return 1

    bindings = BINDINGS.read_text()
    inits, methods = read_api(bindings)
    enum_cases = read_enum_cases(bindings)
    if not inits or not methods:
        print("error: could not read any API out of the bindings; has their shape changed?")
        return 1

    sources = [
        path
        for root in SOURCE_ROOTS
        for path in root.rglob("*.swift")
        if not any(skip in str(path) for skip in SKIP)
    ]

    targets: list[tuple[str, str, list[str]]] = [
        (name, rf"\b{name}\(", expected) for name, expected in inits.items()
    ]
    targets += [
        (f"workspace.{name}", rf"\bworkspace\.{name}\(", expected)
        for name, expected in methods.items()
    ]

    problems: list[str] = []
    checked = 0
    for path in sources:
        source = path.read_text()
        for name, pattern, expected in targets:
            for match in re.finditer(pattern, source):
                args = balanced_args(source, match.end() - 1)
                if args is None:
                    continue
                used = top_level_labels(args)
                if not used:
                    continue
                checked += 1
                where = path.relative_to(REPO)
                unknown = [label for label in used if label not in expected]
                if unknown:
                    problems.append(
                        f"{where}: {name}(…) uses {unknown}, which the bindings do not declare"
                        f" — it takes {expected}"
                    )
                    continue
                order = [expected.index(label) for label in used]
                if order != sorted(order):
                    problems.append(
                        f"{where}: {name}(…) passes {used} — Swift requires declaration order,"
                        f" which is {expected}"
                    )

    problems += check_enum_cases(sources, enum_cases)

    print(
        f"checked {checked} call sites and {len(enum_cases)} enums"
        f" in {len(sources)} files against the generated bindings"
    )
    for problem in sorted(set(problems)):
        print(f"  ✗ {problem}")
    if problems:
        print("\nThe app and the bindings disagree. Either the call sites are stale, or the")
        print("bindings are — run scripts/gen-swift-bindings.sh and look at the diff.")
        return 1
    print("  ✓ every call site matches")
    return 0


if __name__ == "__main__":
    sys.exit(main())
