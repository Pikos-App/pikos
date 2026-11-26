import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

let built = false;

/**
 * The release `pikos` binary, built on first use in this worker. CI builds it once per run and
 * names it in PIKOS_CLI_BIN, so a shard never compiles it.
 */
export function pikosCli(): string {
  const prebuilt = process.env["PIKOS_CLI_BIN"];
  if (prebuilt) return prebuilt;

  if (!built) {
    execFileSync("cargo", ["build", "--release", "-p", "pikos-cli"], {
      cwd: ROOT,
      stdio: "ignore",
    });
    built = true;
  }

  return join(ROOT, "target/release/pikos");
}
