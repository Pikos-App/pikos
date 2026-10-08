import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

let built = false;

/** The release `pikos` binary, built on first use in this worker. */
export function pikosCli(): string {
  if (!built) {
    execFileSync("cargo", ["build", "--release", "-p", "pikos-cli"], {
      cwd: ROOT,
      stdio: "ignore",
    });
    built = true;
  }
  return join(ROOT, "target/release/pikos");
}
