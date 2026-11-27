#!/usr/bin/env node
// The screen half of the release gate: refuse a release whose screens nobody reviewed.
//
//   node scripts/check-screen-review.mjs [--platform desktop|ios]   check; prints the record line
//
// The agent screen review records the commit it read in a private record beside the QA master.
// A release passes when that review's commit is this one, or when nothing a person sees changed
// between the two. release.sh runs it for the desktop; SKIP_SCREEN_REVIEW="<why>" bypasses it.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = join(import.meta.dirname, "..");
const RECORD = join(ROOT, ".agent/qa/screen-review.json");

/**
 * Everything that ships in each app. Shared code counts: a change to date handling in the core
 * changes the labels a person reads, so only docs, scripts and tests leave screens as reviewed.
 */
export const SCREEN_PATHS = {
  desktop: ["apps/desktop", "packages", "crates", ":!**/*.test.*", ":!**/tests/**", ":!**/e2e/**", ":!**/*.md"],
  ios: ["apps/ios", "apps/apple", "packages", "crates", ":!**/*.test.*", ":!**/tests/**", ":!**/e2e/**", ":!**/*.md"],
};

/** Why the release must wait, or null when the recorded review still covers `head`. */
export function screenReviewProblem(record, platform, head, changedSince) {
  const review = record?.[platform];
  if (!review?.commit) {
    return `no ${platform} screen review is recorded. Run the ${platform} screen tour, then the screen review, and commit nothing in between.`;
  }
  if (review.commit === head) return null;
  const changed = changedSince(review.commit, SCREEN_PATHS[platform]);
  if (changed === null) {
    return `the ${platform} screen review's commit ${review.commit.slice(0, 9)} isn't in this branch's history. Review the screens again.`;
  }
  if (changed.length === 0) return null;
  return `${changed.length} file(s) a person sees changed since the ${platform} screen review at ${review.commit.slice(0, 9)} (${review.date}), for example ${changed[0]}. Review the screens again.`;
}

function changedSince(commit, paths) {
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", commit, "HEAD"], { cwd: ROOT, stdio: "ignore" });
  } catch {
    return null;
  }
  const out = execFileSync("git", ["diff", "--name-only", commit, "HEAD", "--", ...paths], {
    cwd: ROOT,
    encoding: "utf8",
  });
  return out.split("\n").filter(Boolean);
}

// Compared as resolved file URLs, so a path with a space or a symlink still runs the check rather
// than skipping it and exiting 0.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const at = process.argv.indexOf("--platform");
  const platform = at === -1 ? "desktop" : process.argv[at + 1];
  if (!SCREEN_PATHS[platform]) {
    console.error("usage: node scripts/check-screen-review.mjs [--platform desktop|ios]");
    process.exit(2);
  }
  const record = existsSync(RECORD) ? JSON.parse(readFileSync(RECORD, "utf8")) : null;
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
  const problem = screenReviewProblem(record, platform, head, changedSince);
  if (problem) {
    console.error(`✗ Screen review: ${problem} SKIP_SCREEN_REVIEW="<why>" releases anyway and records why.`);
    process.exit(1);
  }
  const review = record[platform];
  console.log(`Screen review: ${platform} screens reviewed at ${review.commit.slice(0, 9)} on ${review.date}.`);
}
