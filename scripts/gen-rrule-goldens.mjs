// Generates golden occurrence fixtures from rrule.js for the corpus of rules
// the Rust engine (crates/pikos-recurrence) must reproduce byte-for-byte.
//
// rrule.js was Pikos's production recurrence engine before the wasm engine
// replaced it; these fixtures pin the migration. The `rrule` npm package is
// intentionally NOT a workspace dependency anymore — run this with:
//   cd "$(mktemp -d)" && npm install rrule@2.8.1 >/dev/null && cd -
//   NODE_PATH=<tmpdir>/node_modules node scripts/gen-rrule-goldens.mjs
// and commit the regenerated fixtures only alongside corpus changes.

import { createRequire } from "module";
import { writeFileSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";

// Resolve rrule from the invoking directory so the package doesn't need to be
// installable from this script's own location.
const require = createRequire(path.join(process.cwd(), "resolve-anchor.js"));
const { RRule } = require("rrule");

const OCCURRENCE_LIMIT = 20;

// dtstarts chosen to stress anchors: weekday vs weekend, month ends, leap
// February, year boundaries. Naive wall-clock ISO, engine convention.
const DTSTARTS = [
  "2026-03-02T09:00:00", // Monday
  "2026-03-08T23:30:00", // Sunday, late evening
  "2026-01-31T12:00:00", // month end (short-month skips)
  "2024-02-29T08:15:00", // leap day
  "2025-12-31T00:00:00", // year boundary
];

const RULES = [
  "FREQ=DAILY",
  "FREQ=DAILY;INTERVAL=3",
  "FREQ=DAILY;COUNT=7",
  "FREQ=DAILY;UNTIL=20260315T235959Z",
  "FREQ=DAILY;BYDAY=MO,WE,FR",
  "FREQ=DAILY;BYMONTH=3,4",
  "FREQ=WEEKLY",
  "FREQ=WEEKLY;INTERVAL=2",
  "FREQ=WEEKLY;BYDAY=MO",
  "FREQ=WEEKLY;BYDAY=MO,WE,FR",
  "FREQ=WEEKLY;BYDAY=SA,SU;INTERVAL=2",
  "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;COUNT=12",
  "FREQ=WEEKLY;BYDAY=TU;UNTIL=20260630T235959Z",
  "FREQ=WEEKLY;INTERVAL=2;WKST=SU;BYDAY=TU,TH",
  "FREQ=WEEKLY;INTERVAL=3;BYDAY=SU,MO",
  "FREQ=MONTHLY",
  "FREQ=MONTHLY;INTERVAL=2",
  "FREQ=MONTHLY;BYMONTHDAY=15",
  "FREQ=MONTHLY;BYMONTHDAY=31",
  "FREQ=MONTHLY;BYMONTHDAY=-1",
  "FREQ=MONTHLY;BYMONTHDAY=1,15,-1",
  "FREQ=MONTHLY;BYDAY=2MO",
  "FREQ=MONTHLY;BYDAY=-1FR",
  "FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1",
  "FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=1",
  "FREQ=MONTHLY;BYDAY=SA,SU;BYSETPOS=1,2",
  "FREQ=MONTHLY;BYDAY=WE;COUNT=10",
  "FREQ=MONTHLY;BYMONTH=1,7;BYMONTHDAY=10",
  "FREQ=YEARLY",
  "FREQ=YEARLY;INTERVAL=2",
  "FREQ=YEARLY;COUNT=5",
  "FREQ=YEARLY;BYMONTH=6",
  "FREQ=YEARLY;BYMONTH=6;BYMONTHDAY=21",
  "FREQ=YEARLY;BYMONTH=11;BYDAY=4TH", // US Thanksgiving
  "FREQ=YEARLY;BYMONTH=5;BYDAY=MO;BYSETPOS=-1", // Memorial Day
  "FREQ=YEARLY;BYMONTHDAY=-1;BYMONTH=12",
];

// rrule.js operates in fake-UTC: feed it UTC datetimes whose fields carry the
// wall-clock values, read UTC fields back.
function toFakeUtc(iso) {
  const [date, time] = iso.split("T");
  const [y, m, d] = date.split("-").map(Number);
  const [hh, mm, ss] = time.split(":").map(Number);
  return new Date(Date.UTC(y, m - 1, d, hh, mm, ss));
}

function fromFakeUtc(d) {
  const pad = (n) => String(n).padStart(2, "0");
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`
  );
}

const cases = [];
for (const rrule of RULES) {
  for (const dtstart of DTSTARTS) {
    const rule = new RRule({
      ...RRule.parseString(rrule),
      dtstart: toFakeUtc(dtstart),
    });
    const occurrences = rule
      .all((_, i) => i < OCCURRENCE_LIMIT)
      .map(fromFakeUtc);
    cases.push({ rrule, dtstart, occurrences });
  }
}

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(
  here,
  "../crates/pikos-recurrence/tests/fixtures/rrule_js_goldens.json"
);
writeFileSync(out, JSON.stringify({ limit: OCCURRENCE_LIMIT, cases }, null, 1) + "\n");
console.log(`wrote ${cases.length} cases to ${out}`);
