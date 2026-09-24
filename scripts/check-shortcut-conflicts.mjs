#!/usr/bin/env node
// Fail when two keyboard shortcuts claim the same combo in the same scope.
//
// The registry already detects this at runtime and calls log.warn, then
// registers both anyway. Whichever binding wins is then decided by registration
// order, which is mount order, which is nobody's decision — so the shortcut
// works until an unrelated component mounts and silently does something else.
// A warning in a log file is not a gate; this is.
//
// Deliberately a text scan over call sites rather than a runtime assertion
// against the registry: a runtime check only sees bindings that a given render
// happened to mount, and the collisions that matter are exactly the ones where
// two components rarely mount together.
//
// A combo may legitimately be shared when the two owners can never coexist.
// That is a decision, so it goes in ALLOWED below with its reason rather than
// passing silently.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "apps/desktop/src");

// Each entry silences one `scope::combo` and must say why it is not a defect.
// Removing an entry is how a fix proves itself.
const ALLOWED = new Map([
  [
    "modal::mod+backspace",
    "The two calendar popovers both claim it. Known defect, not a decision — " +
      "they do mount together, and the winner is whichever rendered last.",
  ],
  [
    "modal::mod+shift+backspace",
    "Same pair, same defect as modal::mod+backspace.",
  ],
]);

// A scoped binding always beats a global one on the same combo — that is what
// scopes are for, and it is invisible: the global shortcut simply stops working
// wherever the scope is active, with no warning from the registry, which sees
// no conflict at all. Usually deliberate. Sometimes it means a shortcut is dead
// exactly where a user would reach for it.
//
// Same rule as ALLOWED: each entry says why the shadowing is wanted.
const ALLOWED_SHADOWING = new Map([
  [
    "mod+backspace",
    "An open calendar popover owns delete while it is open, ahead of the page " +
      "list's. Deliberate: the popover is what the user is looking at.",
  ],
  [
    "mod+shift+backspace",
    "Same pair, same reason as mod+backspace.",
  ],
  [
    "mod+shift+k",
    "The editor's insert-link shadows the global command palette. Known " +
      "defect rather than a decision: it takes the combo exactly where the " +
      "palette is most wanted, and nothing tells the user why nothing happened.",
  ],
]);

const MODIFIERS = new Set(["mod", "cmd", "meta", "ctrl", "control", "alt", "option", "shift"]);

/** Platform aliases collapse, modifier order stops mattering, case stops mattering. */
function normalizeCombo(combo) {
  const parts = combo.split("+").map((p) => p.trim().toLowerCase());
  const mods = [];
  const keys = [];
  for (const p of parts) {
    if (!MODIFIERS.has(p)) {
      keys.push(p);
      continue;
    }
    // The registry maps cmd/meta to mod on macOS and ctrl elsewhere; for the
    // purpose of "do these two collide", they are one token.
    if (p === "cmd" || p === "meta") mods.push("mod");
    else if (p === "control") mods.push("ctrl");
    else mods.push(p);
  }
  return [...new Set(mods)].sort().concat(keys).join("+");
}

function* sourceFiles(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      yield* sourceFiles(full);
      continue;
    }
    if (!/\.tsx?$/.test(entry)) continue;
    if (/\.test\.tsx?$/.test(entry)) continue;
    yield full;
  }
}

/** The call's source text, from its opening paren to the one that closes it. */
function callText(text, openParen) {
  let depth = 0;
  for (let i = openParen; i < text.length; i += 1) {
    if (text[i] === "(") depth += 1;
    else if (text[i] === ")") {
      depth -= 1;
      if (depth === 0) return text.slice(openParen, i + 1);
    }
  }
  return null;
}

const bindings = [];
const NEEDLE = "useKeyboardShortcut(";

for (const file of sourceFiles(SRC)) {
  const text = readFileSync(file, "utf8");
  let from = 0;
  for (;;) {
    const at = text.indexOf(NEEDLE, from);
    if (at === -1) break;
    from = at + NEEDLE.length;

    const call = callText(text, at + NEEDLE.length - 1);
    if (!call) continue;

    // A combo is always the first argument and always a literal — a computed
    // one could not be checked here, and none exist.
    const combo = call.match(/^\(\s*"([^"]+)"/)?.[1];
    if (!combo) continue;

    const scope = call.match(/\bscope:\s*"([^"]+)"/)?.[1] ?? "global";
    const line = text.slice(0, at).split("\n").length;
    bindings.push({ combo, file: relative(ROOT, file), line, scope });
  }
}

const bySignature = new Map();
for (const b of bindings) {
  const signature = `${b.scope}::${normalizeCombo(b.combo)}`;
  const group = bySignature.get(signature) ?? [];
  group.push(b);
  bySignature.set(signature, group);
}

const unexpected = [];
const staleAllowances = new Set(ALLOWED.keys());

for (const [signature, group] of bySignature) {
  if (group.length < 2) continue;
  if (ALLOWED.has(signature)) {
    staleAllowances.delete(signature);
    continue;
  }
  unexpected.push([signature, group]);
}

// A combo claimed both globally and inside some scope: the scoped owner wins
// there, silently, and the registry never calls it a conflict.
const shadowed = [];
const staleShadowAllowances = new Set(ALLOWED_SHADOWING.keys());

for (const b of bindings) {
  if (b.scope !== "global") continue;
  const combo = normalizeCombo(b.combo);
  const scopedOwners = bindings.filter(
    (other) => other.scope !== "global" && normalizeCombo(other.combo) === combo
  );
  if (!scopedOwners.length) continue;
  if (ALLOWED_SHADOWING.has(combo)) {
    staleShadowAllowances.delete(combo);
    continue;
  }
  shadowed.push([combo, b, scopedOwners]);
}

let failed = false;

if (shadowed.length) {
  failed = true;
  console.error(`\n${shadowed.length} global shortcut(s) shadowed inside a scope:\n`);
  for (const [combo, global, owners] of shadowed) {
    console.error(`  ${combo}`);
    console.error(`    global  ${global.file}:${global.line}`);
    for (const o of owners) console.error(`    ${o.scope}  ${o.file}:${o.line}`);
    console.error("");
  }
  console.error("The global binding is dead wherever that scope is active. Record it in");
  console.error("ALLOWED_SHADOWING with its reason, or give one of them a different combo.\n");
}

if (staleShadowAllowances.size) {
  failed = true;
  console.error(`\n${staleShadowAllowances.size} ALLOWED_SHADOWING entr(y/ies) no longer apply:\n`);
  for (const combo of staleShadowAllowances) console.error(`  ${combo}`);
  console.error("\nThe shadowing is gone — delete the entry.\n");
}

if (unexpected.length) {
  failed = true;
  console.error(`\n${unexpected.length} shortcut combo(s) claimed more than once:\n`);
  for (const [signature, group] of unexpected) {
    console.error(`  ${signature}`);
    for (const b of group) console.error(`    ${b.file}:${b.line}  ${b.combo}`);
    console.error("");
  }
  console.error("Give each combo one owner, or record the sharing in ALLOWED with its reason.\n");
}

if (staleAllowances.size) {
  failed = true;
  console.error(`\n${staleAllowances.size} entr(y/ies) in ALLOWED no longer match a conflict:\n`);
  for (const signature of staleAllowances) console.error(`  ${signature}`);
  console.error("\nThe conflict is gone — delete the entry.\n");
}

if (failed) process.exit(1);

console.log(
  `shortcut-conflicts: ${bindings.length} bindings, ` +
    `${bySignature.size} distinct scope+combo, ${ALLOWED.size} known conflict(s) allowed`
);
