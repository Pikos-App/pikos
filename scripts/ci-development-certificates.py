#!/usr/bin/env python3
"""Revoke the Apple Development certificate a TestFlight run made for itself.

    ci-development-certificates.py snapshot <file>
    ci-development-certificates.py revoke-new <file>

Cloud signing needs a development identity to archive with, and a CI runner starts with none, so
every run has Xcode create one through the API. The runner is thrown away afterwards and the
certificate stays on the account until the account's limit stops the next archive. `snapshot`
writes the ids of the development certificates there are before the archive; `revoke-new` revokes
any made since that Xcode named "Created via API", which leaves a person's own alone.

Reads APPLE_API_KEY_PATH, APPLE_API_KEY_ID and APPLE_API_ISSUER_ID. Needs PyJWT with its crypto
extra.
"""

import json
import os
import sys
import time
import urllib.request
from pathlib import Path

import jwt

API = "https://api.appstoreconnect.apple.com/v1/certificates"
CREATED_BY_XCODE = "Created via API"


def token() -> str:
    key = Path(os.environ["APPLE_API_KEY_PATH"]).read_text()
    now = int(time.time())
    return jwt.encode(
        {"iss": os.environ["APPLE_API_ISSUER_ID"], "iat": now, "exp": now + 600, "aud": "appstoreconnect-v1"},
        key,
        algorithm="ES256",
        headers={"kid": os.environ["APPLE_API_KEY_ID"], "typ": "JWT"},
    )


def request(method: str, url: str, auth: str):
    req = urllib.request.Request(url, method=method, headers={"Authorization": f"Bearer {auth}"})
    with urllib.request.urlopen(req) as response:
        body = response.read()
    return json.loads(body) if body else None


def development_certificates(auth: str) -> list[dict]:
    url = f"{API}?filter[certificateType]=DEVELOPMENT,IOS_DEVELOPMENT&limit=200"
    return request("GET", url, auth)["data"]


def main() -> int:
    command, path = sys.argv[1], Path(sys.argv[2])
    auth = token()
    current = development_certificates(auth)

    if command == "snapshot":
        path.write_text("\n".join(cert["id"] for cert in current))
        print(f"{len(current)} development certificates before the archive")
        return 0

    before = set(path.read_text().split())
    new_since = [cert for cert in current if cert["id"] not in before]
    for cert in new_since:
        # The portal's Name column is `displayName`; `name` is the certificate's common name.
        shown_as = cert["attributes"].get("displayName")
        if shown_as != CREATED_BY_XCODE:
            print(f"left {cert['id']}, shown as {shown_as!r}")
            continue
        request("DELETE", f"{API}/{cert['id']}", auth)
        print(f"revoked {cert['id']}")
    if not new_since:
        print("this run made no development certificate")
    return 0


if __name__ == "__main__":
    sys.exit(main())
