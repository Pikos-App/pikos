"""Print the newest of the release versions given, by semver: 0.5.0 is newer than 0.5.0-beta.2.

    python3 scripts/lib/newest-version.py 0.5.0 0.4.0-beta.3   ->  0.5.0

Empty arguments are skipped, so a missing prerelease or stable release can be passed as "".
"""

import re
import sys


def key(version):
    match = re.fullmatch(r"(\d+)\.(\d+)\.(\d+)(?:-(.+))?", version)
    if not match:
        sys.exit(f"not a release version: {version}")
    major, minor, patch, pre = match.groups()
    # A release outranks any of its prereleases; prerelease parts compare numerically where they can.
    pre_parts = tuple((0, int(p), "") if p.isdigit() else (1, 0, p) for p in pre.split(".")) if pre else ()
    return (int(major), int(minor), int(patch), 0 if pre else 1, pre_parts)


versions = [v for v in sys.argv[1:] if v]
if not versions:
    sys.exit("no versions given")
print(max(versions, key=key))
