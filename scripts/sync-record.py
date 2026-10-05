# mitmproxy add-on: record a calendar provider's exchanges with the app as a replay fixture.
#
#   SYNC_RECORD_OUT=<fixture.json> mitmdump -s scripts/sync-record.py ...
#
# Each request and its response become one exchange, in order. Credentials never reach the file:
# no request header is kept, only a few response headers are, and OAuth token fields are blanked. The
# fixture carries the day it was recorded, because a recording that outlives the provider's real
# behaviour keeps passing while testing nothing; the replay test fails it once it's too old.
import datetime
import json
import os
import re

from mitmproxy import http

OUT = os.environ["SYNC_RECORD_OUT"]
KEEP_RESPONSE_HEADERS = {"content-type", "dav", "etag", "location"}
TOKEN_FIELDS = re.compile(r'("(?:access_token|refresh_token|id_token|code)"\s*:\s*)"[^"]*"')

exchanges = []
origins = set()


def _text(body: bytes) -> str:
    return TOKEN_FIELDS.sub(r'\1"scrubbed"', body.decode("utf-8", errors="replace"))


def response(flow: http.HTTPFlow) -> None:
    origins.add(f"{flow.request.scheme}://{flow.request.host_header or flow.request.host}")
    exchanges.append(
        {
            "method": flow.request.method,
            "path": flow.request.path,
            "status": flow.response.status_code,
            "headers": {
                k.lower(): v for k, v in flow.response.headers.items() if k.lower() in KEEP_RESPONSE_HEADERS
            },
            "body": _text(flow.response.content or b""),
        }
    )


def done() -> None:
    fixture = {
        "recorded": datetime.date.today().isoformat(),
        "origins": sorted(origins),
        "exchanges": exchanges,
    }
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(fixture, f, indent=2, ensure_ascii=False)
        f.write("\n")
