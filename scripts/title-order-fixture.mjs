// Writes crates/pikos-db/src/title_order_fixture.json: how the system's JavaScriptCore, the engine
// the app's window runs, orders a set of awkward titles in several languages with the collator the
// app sorts titles with. The title_key tests check the database's keys put them in the same order.
// macOS only, since it runs the system's own `jsc`.
//
//   node scripts/title-order-fixture.mjs

import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const JSC = "/System/Library/Frameworks/JavaScriptCore.framework/Versions/A/Helpers/jsc";
const OUT = join(
  dirname(fileURLToPath(import.meta.url)),
  "../crates/pikos-db/src/title_order_fixture.json"
);

const LOCALES = [
  "en-US",
  "de-DE",
  "sv-SE",
  "fr-FR",
  "es-ES",
  "tr-TR",
  "da-DK",
  "pl-PL",
  "ja-JP",
  "ko-KR",
  "zh-Hans-CN",
];

const TITLES = [
  "Élan", "élan", "Elan", "ZEBRA", "zebra", "apple", "Apple", "Äpfel", "Apfel",
  "item 2", "Item 10", "Item 9", "item 100", "a1b", "a10b", "a2b", "0", "00", "007", "1.5", "1,5",
  "1st", "2nd", "10th", "½", "x²", "-5", "−5",
  "🎉 Party", "🎉Party", "Party", "❤️ heart", "heart", "👨‍👩‍👧 family", "family", "🙂", "",
  "ß", "ss", "Straße", "Strasse", "ä", "z", "å", "ö", "o", "Ölmalerei", "Zucker",
  "çava", "cava", "ch", "cz", "h", "İstanbul", "Istanbul", "ılık", "ilik",
  "ñandú", "nandu", "Łódź", "Lodz", "Ærø", "Aero", "résumé", "resume", "Resume",
  "co-op", "coop", "e-mail", "email", "café", "cafe", "naïve", "naive", "ﬁle", "file",
  "-dash", "_under", "(paren)", "#tag", "東京", "大阪", "あ", "ア", "한국", "Ωmega", "Alpha",
];

// The same strip and collator as packages/core/src/utils/sort.ts, with each locale named.
const program = `
const locales = ${JSON.stringify(LOCALES)};
const titles = ${JSON.stringify(TITLES)};
const strip = (s) => s.replace(/^(?:\\p{Extended_Pictographic}|\\s|\\u200D|\\uFE0F|\\uFE0E)+/u, "");
const groups = {};
for (const locale of locales) {
  const collator = new Intl.Collator(locale, { numeric: true });
  const compare = (a, b) => collator.compare(strip(a), strip(b));
  const out = [];
  for (const title of [...titles].sort(compare)) {
    const last = out[out.length - 1];
    if (last && compare(last[0], title) === 0) last.push(title);
    else out.push([title]);
  }
  groups[locale] = out;
}
print(JSON.stringify(groups));
`;

const dir = mkdtempSync(join(tmpdir(), "title-order-"));
const file = join(dir, "order.js");
writeFileSync(file, program);
const groups = JSON.parse(execFileSync(JSC, [file], { encoding: "utf8" }));
const engine = `JavaScriptCore, macOS ${execFileSync("sw_vers", ["-productVersion"], { encoding: "utf8" }).trim()}`;

writeFileSync(OUT, `${JSON.stringify({ engine, groups }, null, 1)}\n`);
console.log(`wrote ${OUT}`);
