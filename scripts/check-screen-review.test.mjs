import assert from "node:assert/strict";
import { test } from "node:test";

import { screenReviewProblem } from "./check-screen-review.mjs";

const record = { desktop: { commit: "aaaaaaaaaa", date: "2026-11-26" } };
const nothingChanged = () => [];

test("a review of this very commit passes", () => {
  assert.equal(screenReviewProblem(record, "desktop", "aaaaaaaaaa", () => assert.fail()), null);
});

test("a review of an earlier commit passes when no screen file changed since", () => {
  assert.equal(screenReviewProblem(record, "desktop", "bbbbbbbbbb", nothingChanged), null);
});

test("a screen file changed since the review refuses the release and names it", () => {
  const problem = screenReviewProblem(record, "desktop", "bbbbbbbbbb", () => ["apps/desktop/src/App.tsx"]);
  assert.match(problem, /1 file\(s\) a person sees changed/);
  assert.match(problem, /apps\/desktop\/src\/App\.tsx/);
});

test("a review on a commit outside this history refuses the release", () => {
  assert.match(screenReviewProblem(record, "desktop", "bbbbbbbbbb", () => null), /isn't in this branch's history/);
});

test("no review for the platform refuses the release", () => {
  assert.match(screenReviewProblem(record, "ios", "bbbbbbbbbb", nothingChanged), /no ios screen review/);
  assert.match(screenReviewProblem(null, "desktop", "bbbbbbbbbb", nothingChanged), /no desktop screen review/);
});
