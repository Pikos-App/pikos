# mitmproxy add-on: record a calendar provider's exchanges with the app as a replay fixture.
#
#   SYNC_RECORD_OUT=<fixture.json> [SYNC_RECORD_REDACT="Full Name,..."] mitmdump -s scripts/sync-record.py ...
#
# Each request and its response become one exchange, in order. Credentials never reach the file:
# no request header is kept, only a few response headers are, and OAuth token fields are blanked.
#
# Nor does the account's identity, since fixtures are committed and a recording can be made on a
# real account. Every email address becomes a placeholder, as does an iCloud account number in a
# path, consistently, so the replay still matches requests to responses. Calendars not named
# "Pikos QA…" are dropped from listings, except Google's primary calendar, whose id is how the app
# labels the account. SYNC_RECORD_REDACT names anything else, such as the holder's name. If an
# email's local part, a custom domain or an account number survives anywhere, nothing is written,
# and the terminal shows where, so the person who owns the data judges it rather than an agent.
#
# The fixture carries the day it was recorded, because a recording that outlives the provider's
# real behaviour keeps passing while testing nothing; the replay test fails it once it's too old.
import datetime
import json
import os
import re
import sys
import urllib.parse

OUT = os.environ["SYNC_RECORD_OUT"]
_REDACT = [n.strip() for n in os.environ.get("SYNC_RECORD_REDACT", "").split(",") if n.strip()]
# Whole entries first, then each word of them, since a provider can show a surname on its own.
NAMES = _REDACT + sorted({w for n in _REDACT for w in n.split() if len(w) >= 3} - set(_REDACT), key=len, reverse=True)
KEEP_RESPONSE_HEADERS = {"content-type", "dav", "etag", "location"}
TOKEN_FIELDS = re.compile(r'("(?:access_token|refresh_token|id_token|code)"\s*:\s*)"[^"]*"')
QA_CALENDAR = "Pikos QA"

EMAIL = re.compile(r"[A-Za-z0-9._+-]+(?:@|%40)[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}")
SAFE_EMAIL_DOMAINS = ("example.com", "qa.pikos.app", "group.calendar.google.com")
SHARED_MAIL_DOMAINS = {
    "gmail.com", "googlemail.com", "google.com", "icloud.com", "me.com", "mac.com",
    "fastmail.com", "fastmail.fm", "messagingengine.com",
}
ACCOUNT_NUMBER = re.compile(r"(?<=/)\d{6,}(?=/)")

RESPONSE = re.compile(r"<(?P<p>(?:[\w-]+:)?)response\b[^>]*>.*?</(?P=p)response>", re.S)
DISPLAYNAME = re.compile(r"<(?P<p>(?:[\w-]+:)?)displayname\b[^>]*>(?P<v>.*?)</(?P=p)displayname>", re.S)
HREF = re.compile(r"<(?P<p>(?:[\w-]+:)?)href\b[^>]*>(?P<v>.*?)</(?P=p)href>", re.S)
PRIMARY_FIELDS = {"kind", "etag", "id", "summary", "timeZone", "accessRole", "primary", "backgroundColor"}

exchanges = []
origins = set()
emails: dict[str, str] = {}
numbers: dict[str, str] = {}


def _email(m: re.Match) -> str:
    found = m.group(0)
    encoded = "%40" in found
    address = found.replace("%40", "@").lower()
    # A CalDAV server can name an event's file after its UID, and the extension reads as a TLD.
    if address.removesuffix(".ics").endswith(SAFE_EMAIL_DOMAINS):
        return found
    placeholder = emails.setdefault(address, f"qa{len(emails) + 1}@example.com")
    return placeholder.replace("@", "%40") if encoded else placeholder


def _number(m: re.Match) -> str:
    return numbers.setdefault(m.group(0), str(10_000_000 + len(numbers) + 1))


def scrub(s: str) -> str:
    s = TOKEN_FIELDS.sub(r'\1"scrubbed"', s)
    s = EMAIL.sub(_email, s)
    s = ACCOUNT_NUMBER.sub(_number, s)
    for name in NAMES:
        s = re.sub(rf"\b{re.escape(name)}\b", "QA User", s, flags=re.I)
    return s


def drop_other_dav_calendars(body: str, path: str) -> str:
    own = urllib.parse.unquote(path).rstrip("/")

    def keep(m: re.Match) -> str:
        block = m.group(0)
        name = DISPLAYNAME.search(block)
        if not name:
            return block
        value = name.group("v").replace("<![CDATA[", "").replace("]]>", "").strip()
        href = HREF.search(block)
        is_own = href and urllib.parse.unquote(href.group("v").strip()).rstrip("/").endswith(own)
        return block if not value or value.startswith(QA_CALENDAR) or is_own else ""

    return RESPONSE.sub(keep, body)


def drop_other_google_calendars(body: str) -> str:
    try:
        data = json.loads(body)
    except ValueError:
        return body
    if not isinstance(data, dict) or data.get("kind") != "calendar#calendarList":
        return body
    kept = []
    for item in data.get("items", []):
        if item.get("primary"):
            item = {k: v for k, v in item.items() if k in PRIMARY_FIELDS}
            item["summary"] = item["id"]
            kept.append(item)
        elif (item.get("summaryOverride") or item.get("summary", "")).startswith(QA_CALENDAR):
            kept.append(item)
    data["items"] = kept
    return json.dumps(data, indent=2, ensure_ascii=False)


def response(flow) -> None:
    origins.add(f"{flow.request.scheme}://{flow.request.host_header or flow.request.host}")
    body = (flow.response.content or b"").decode("utf-8", errors="replace")
    body = drop_other_google_calendars(drop_other_dav_calendars(body, flow.request.path))
    exchanges.append(
        {
            "method": flow.request.method,
            "path": scrub(flow.request.path),
            "status": flow.response.status_code,
            "headers": {
                k.lower(): scrub(v)
                for k, v in flow.response.headers.items()
                if k.lower() in KEEP_RESPONSE_HEADERS
            },
            "body": scrub(body),
        }
    )


def leftovers() -> list[str]:
    """Where an identifier survived, with the text around it, for the person recording to judge.
    It goes to their terminal only, since the file is never written."""
    needles = []
    for address, placeholder in emails.items():
        local, domain = address.split("@", 1)
        if len(local) >= 4:
            needles.append((f"the local part of {placeholder}", local))
        if domain not in SHARED_MAIL_DOMAINS:
            needles.append((f"the domain of {placeholder}", domain))
    needles += [(f"account number {placeholder}", n) for n, placeholder in numbers.items()]
    found = []
    for i, e in enumerate(exchanges):
        fields = {"path": e["path"], "body": e["body"], **{f"header {k}": v for k, v in e["headers"].items()}}
        for field, value in fields.items():
            lowered = value.lower()
            for kind, needle in needles:
                at = lowered.find(needle)
                if at >= 0:
                    context = value[max(0, at - 60) : at + len(needle) + 60].replace("\r", "").replace("\n", " ")
                    found.append(f"  {kind}, exchange {i} ({e['method']} {e['path']}) {field}:\n    …{context}…")
    return found


def done() -> None:
    left = leftovers()
    if left:
        sys.stderr.write("sync-record: not written. These survived the scrub:\n" + "\n".join(left) + "\n")
        return
    fixture = {
        "recorded": datetime.date.today().isoformat(),
        "origins": sorted(origins),
        "exchanges": exchanges,
    }
    text = json.dumps(fixture, indent=2, ensure_ascii=False) + "\n"
    with open(OUT, "w", encoding="utf-8") as f:
        f.write(text)
