import { execFileSync, spawnSync } from "node:child_process";

import { pikosCli } from "./cli";
import { test as appTest, expect, quickAdd, quitApp, WRITE_QUEUE_DEBOUNCE_MS } from "./fixtures";

appTest(
  "a workspace a newer build migrated opens to an update message, and the CLI exits 6",
  { tag: ["@UPD-04"] },
  async ({ app, storage }) => {
    appTest.skip(storage !== "bridge", "UPD-04 marks the real writer's file as migrated by a newer build");
    await quickAdd(app, "Kept safe");
    await app.waitForTimeout(2 * WRITE_QUEUE_DEBOUNCE_MS);
    const file = await quitApp(app);
    execFileSync("sqlite3", [
      file,
      "INSERT INTO _sqlx_migrations (version, description, success, checksum, execution_time) VALUES (9999, 'newer', 1, x'00', 0)",
    ]);
    await app.goto("/");

    await appTest.step("UPD-04 This workspace needs a newer Pikos, and the pages are fine", async () => {
      await expect(app.getByText("This workspace needs a newer Pikos")).toBeVisible();
      await expect(app.getByText(/Your pages are fine\. Update this copy of Pikos/)).toBeVisible();
      await expect(app.getByRole("main", { name: "Workspace" })).toHaveCount(0);
    });

    await appTest.step("UPD-04 the detail names v9999 and this build's version", async () => {
      await expect(app.getByText(/schema v9999, this build reads up to v\d+/)).toBeVisible();
    });

    await appTest.step("UPD-04 pikos today on it exits 6 with SchemaTooNew", () => {
      const run = spawnSync(pikosCli(), ["--db", file, "today"], { encoding: "utf8" });
      expect(run.status).toBe(6);
      expect(`${run.stdout}${run.stderr}`).toContain("SchemaTooNew");
    });
  }
);
