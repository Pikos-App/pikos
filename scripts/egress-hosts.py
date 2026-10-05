# mitmproxy add-on for scripts/check-egress.mjs: record every host a client asks the proxy for,
# and refuse it, so nothing the app sends leaves the machine while it's being watched.
import json
import os

from mitmproxy import http

LOG = os.environ["EGRESS_LOG"]


def _record(host: str, how: str) -> None:
    with open(LOG, "a", encoding="utf-8") as f:
        f.write(json.dumps({"host": host, "how": how}) + "\n")


def http_connect(flow: http.HTTPFlow) -> None:
    _record(flow.request.host, "connect")
    flow.response = http.Response.make(403, b"refused by check-egress")


def request(flow: http.HTTPFlow) -> None:
    if flow.response is None:
        _record(flow.request.pretty_host, "request")
        flow.response = http.Response.make(403, b"refused by check-egress")
