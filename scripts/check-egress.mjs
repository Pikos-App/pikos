#!/usr/bin/env node
// Privacy, checked rather than claimed: run the real app through a proxy that records and refuses
// every host it asks for, and fail if it asked for any.
//
//   node scripts/check-egress.mjs
//
// The app is the benchmark build, driven through its scripted session (launch, lists, opening
// pages, search, edits, the calendar) against a 2,000-page workspace with no calendar accounts.
// Nothing in that session has a reason to touch the network, so the allowed list is empty: a host
// here is a call nobody chose. The webview can't reach the network past its content security
// policy, so the proxy watches the native side, where every network client lives.
//
// It proves the proxy first, with one request of its own that must show up in the log.

import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 18765;
const PROXY = `http://127.0.0.1:${PORT}`;
/** Hosts the session may reach. None: no account is connected and the bench build never updates. */
const ALLOWED = new Set();
const SELF_TEST_HOST = "egress-self-test.pikos.invalid";

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function listening() {
  return spawnSync("nc", ["-z", "127.0.0.1", String(PORT)]).status === 0;
}

function hosts(log) {
  let text = "";
  try {
    text = readFileSync(log, "utf8");
  } catch {
    return [];
  }
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line).host);
}

const work = mkdtempSync(join(tmpdir(), "pikos-egress-"));
const log = join(work, "hosts.jsonl");
if (listening()) {
  console.error(`check-egress: something already listens on ${PORT}`);
  process.exit(1);
}
const proxy = spawn(
  "mitmdump",
  [
    "--listen-host",
    "127.0.0.1",
    "-p",
    String(PORT),
    "-q",
    "-s",
    join(ROOT, "scripts/egress-hosts.py"),
  ],
  { env: { ...process.env, EGRESS_LOG: log }, stdio: "ignore" }
);
let code = 1;
try {
  for (let i = 0; i < 100 && !listening(); i++) sleep(100);
  if (!listening()) throw new Error("mitmdump never started listening");

  spawnSync("curl", ["-s", "-x", PROXY, "--max-time", "5", `https://${SELF_TEST_HOST}/`]);
  if (!hosts(log).includes(SELF_TEST_HOST)) {
    throw new Error(
      "the proxy didn't record its own test request, so a clean run would prove nothing"
    );
  }

  const bench = spawnSync(
    "node",
    [
      join(ROOT, "apps/marketing/scripts/benchmark-app.mjs"),
      "--quick",
      "--sizes",
      "2000",
      "--samples",
      "3",
      "--app-proxy",
      PROXY,
    ],
    { cwd: ROOT, stdio: "inherit" }
  );
  if (bench.status !== 0) throw new Error("the app session didn't finish");

  const reached = [...new Set(hosts(log).filter((h) => h !== SELF_TEST_HOST))];
  const unexpected = reached.filter((h) => !ALLOWED.has(h));
  if (unexpected.length > 0) {
    console.error(`check-egress: the app asked for ${unexpected.join(", ")}`);
  } else {
    console.log("check-egress: the app reached no host through a full session");
    code = 0;
  }
} catch (e) {
  console.error(`check-egress: ${e.message}`);
} finally {
  proxy.kill();
  rmSync(work, { force: true, recursive: true });
}
process.exit(code);
