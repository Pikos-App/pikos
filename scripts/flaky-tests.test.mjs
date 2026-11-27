import assert from "node:assert/strict";
import { test } from "node:test";

import { flakyTests } from "./flaky-tests.mjs";

const report = {
  suites: [
    {
      file: "e2e/pages.spec.ts",
      specs: [
        { title: "creates a page", tests: [{ projectName: "e2e", status: "expected" }] },
        { title: "renames a page", tests: [{ projectName: "e2e", status: "flaky" }] },
      ],
      suites: [
        {
          title: "nested describe",
          specs: [{ title: "drags a page", tests: [{ projectName: "bridge", status: "flaky" }] }],
        },
      ],
    },
    {
      file: "e2e/search.spec.ts",
      specs: [{ title: "finds a page", tests: [{ projectName: "e2e", status: "unexpected" }] }],
    },
  ],
};

test("names only the tests that passed on a retry, with their file and project", () => {
  assert.deepEqual(flakyTests(report), [
    "e2e/pages.spec.ts › renames a page (e2e)",
    "e2e/pages.spec.ts › drags a page (bridge)",
  ]);
});

test("a report with no flaky test names none", () => {
  assert.deepEqual(flakyTests({ suites: [] }), []);
});
